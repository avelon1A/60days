Coroutines are Kotlin's way to write asynchronous code that reads like normal, top-to-bottom code. Flow builds on top of coroutines to model streams of values over time. These notes go from how a `suspend` function compiles all the way to testing StateFlow in a ViewModel, with the traps that senior Android interviews love to probe.

## Why Coroutines

A coroutine is a piece of work that can **pause** (suspend) without blocking a thread, and **resume** later, maybe on a different thread. Many coroutines can share a small pool of threads.

Before coroutines, Android code used callbacks, RxJava, or raw threads. Callbacks nest badly. RxJava is powerful but has a big API and its own learning curve. Threads are expensive.

### Threads vs coroutines

| Aspect | Thread | Coroutine |
|---|---|---|
| Cost | About 1 MB of stack by default, OS managed | A small object on the heap |
| How many | Thousands at most | Hundreds of thousands is fine |
| Waiting | Blocks the thread | Suspends, frees the thread |
| Switching | OS context switch | Function returns and later resumes |
| Cancellation | Manual flags, interrupt | Built in, cooperative, structured |
| Lifetime | Unbounded unless you manage it | Bound to a scope |

```kotlin
// 100_000 coroutines: fine
runBlocking {
    repeat(100_000) {
        launch {
            delay(1_000)
            print(".")
        }
    }
}
// 100_000 threads each sleeping 1s: likely OutOfMemoryError
```

The key word is **suspend, not block**. `Thread.sleep(1000)` holds the thread hostage. `delay(1000)` gives the thread back and asks to be resumed later.

> **Interview:** Coroutines are not "lightweight threads" in the strict sense. They are suspendable computations that run on threads. A dispatcher decides which thread runs them.

### What you get

- Sequential-looking async code. No callback pyramid.
- Structured concurrency. Work is tied to a scope and cannot leak.
- Built-in cancellation that flows down the tree.
- Exceptions that propagate like normal exceptions.
- First-class support in Jetpack: `viewModelScope`, `lifecycleScope`, Room, Retrofit, DataStore, WorkManager (`CoroutineWorker`).

## Suspend Under the Hood

A `suspend` function is a function that can pause. You can only call it from another suspend function or from a coroutine.

```kotlin
suspend fun loadUser(id: String): User {
    val token = auth.getToken()       // may suspend
    val user = api.fetchUser(id, token) // may suspend
    return user
}
```

### CPS transformation

The compiler rewrites every suspend function using **Continuation-Passing Style (CPS)**. It adds a hidden last parameter of type `Continuation<T>` and changes the return type to `Any?`.

```kotlin
// What you write
suspend fun loadUser(id: String): User

// Roughly what the JVM sees
fun loadUser(id: String, completion: Continuation<User>): Any?
```

The `Any?` return is either the real result (`User`) or the special marker `COROUTINE_SUSPENDED`. The marker means "I paused, I will call your continuation later".

```kotlin
public interface Continuation<in T> {
    public val context: CoroutineContext
    public fun resumeWith(result: Result<T>)
}
```

A continuation is "the rest of the computation". When the async work finishes, someone calls `resumeWith`, and the function picks up where it left off.

### The state machine

Each suspension point becomes a state. The compiler generates a class that stores local variables and a `label` saying where to resume. Below is a **simplified sketch** of the decompiled shape, not exact bytecode.

```kotlin
fun loadUser(id: String, completion: Continuation<User>): Any? {
    val sm = completion as? LoadUserSM ?: LoadUserSM(completion)
    when (sm.label) {
        0 -> {
            sm.id = id
            sm.label = 1
            val r = auth.getToken(sm)
            if (r === COROUTINE_SUSPENDED) return COROUTINE_SUSPENDED
            sm.result = r
        }
        1 -> { /* resumed after getToken */ }
        2 -> return sm.result as User
    }
    val token = sm.result as String
    sm.label = 2
    val r2 = api.fetchUser(sm.id, token, sm)
    if (r2 === COROUTINE_SUSPENDED) return COROUTINE_SUSPENDED
    return r2 as User
}
```

The generated state-machine class looks roughly like this:

```kotlin
class LoadUserSM(val completion: Continuation<User>) : ContinuationImpl(completion) {
    var label = 0
    var id: String? = null
    var result: Any? = null
    override fun invokeSuspend(result: Any?): Any? {
        this.result = result
        return loadUser(id!!, this) // re-enter at the saved label
    }
}
```

Flow of a call:

1. First call: label is 0. It calls `getToken`, passing itself as the continuation.
2. If `getToken` suspends, it returns `COROUTINE_SUSPENDED` all the way up the stack. The thread is free.
3. When the token arrives, `resumeWith` is called. That calls `invokeSuspend`, which re-enters `loadUser` with label 1.
4. Locals were saved in fields, so the function continues as if it never left.

> **Under the hood:** One state-machine object is allocated per suspend function call that actually needs it, not one per suspension point. This is why coroutines are cheap compared to threads with full stacks.

> **Note:** If a suspend function never actually suspends (for example, data is in cache), it returns the value directly and no thread hop happens. `suspend` means "may suspend", not "will suspend".

### suspendCancellableCoroutine

This is how you wrap a callback API into a suspend function.

```kotlin
suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) {
            cont.resume(response)
        }
        override fun onFailure(call: Call, e: IOException) {
            cont.resumeWithException(e)
        }
    })
    cont.invokeOnCancellation { cancel() } // cancel the HTTP call too
}
```

> **Tip:** Prefer `suspendCancellableCoroutine` over `suspendCoroutine`. It supports cancellation and lets you clean up the underlying resource.

## Builders and Scope Functions

A **builder** starts a coroutine. A **scope function** creates a nested scope inside a suspend function.

### launch

Fire and forget. Returns a `Job`. No result value.

```kotlin
val job: Job = scope.launch {
    repository.refresh()
}
job.cancel()
```

### async and await

Returns a `Deferred<T>`, which is a `Job` with a result. Use it for parallel decomposition.

```kotlin
suspend fun loadScreen(): Screen = coroutineScope {
    val user = async { api.user() }
    val feed = async { api.feed() }
    Screen(user.await(), feed.await()) // both run in parallel
}
```

> **Pitfall:** `async { }.await()` right away, one after another, is just sequential code with extra cost. Start all `async` calls first, then await.

You can start lazily with `async(start = CoroutineStart.LAZY)`. It will not run until `start()` or `await()` is called.

### runBlocking

Blocks the current thread until the coroutine inside finishes. It bridges blocking and suspending worlds.

- Fine in `main()` functions and some scripts.
- Never use it on the Android main thread. It can freeze the UI or cause ANRs.
- For tests, use `runTest` instead.

### coroutineScope

Creates a child scope and suspends until all children finish. If any child fails, all others are cancelled and the exception is rethrown.

```kotlin
suspend fun syncAll() = coroutineScope {
    launch { syncContacts() }
    launch { syncPhotos() }
} // returns only when both are done
```

### supervisorScope

Same as `coroutineScope`, but a failing child does **not** cancel its siblings. Use it when tasks are independent.

```kotlin
suspend fun loadWidgets() = supervisorScope {
    launch { loadWeather() }   // can fail alone
    launch { loadNews() }      // keeps running
}
```

### withContext

Switches the context (usually the dispatcher) for a block and returns its result. It suspends the caller until the block is done.

```kotlin
suspend fun readFile(path: String): String = withContext(Dispatchers.IO) {
    File(path).readText()
}
```

### Builder summary

| Builder | Returns | Suspends caller | Typical use |
|---|---|---|---|
| launch | Job | No | Side effects, fire and forget |
| async | Deferred | No (await does) | Parallel results |
| runBlocking | T | Blocks thread | main, scripts |
| coroutineScope | T | Yes | Parallel work inside a suspend fun |
| supervisorScope | T | Yes | Independent children |
| withContext | T | Yes | Switch dispatcher |

> **Interview:** `withContext` vs `async { }.await()`: they do similar things, but `withContext` is simpler and cheaper when you need one result on another dispatcher. Use `async` only when you need parallelism.

## Context and Dispatchers

Every coroutine has a `CoroutineContext`. It is an indexed set of **elements**, keyed by type.

### The main elements

| Element | Purpose |
|---|---|
| Job | Lifecycle, cancellation, parent and child links |
| CoroutineDispatcher | Which thread or pool runs the code |
| CoroutineName | Name for debugging and logs |
| CoroutineExceptionHandler | Last-resort handler for uncaught exceptions |

### The + operator

Contexts combine with `+`. If two elements have the same key, the right side wins.

```kotlin
val ctx = Dispatchers.IO + CoroutineName("sync") + handler
val ctx2 = ctx + Dispatchers.Default // dispatcher replaced, name kept

scope.launch(CoroutineName("refresh")) {
    println(coroutineContext[CoroutineName]) // CoroutineName(refresh)
    println(coroutineContext[Job])          // this coroutine's Job
}
```

A child coroutine's context = parent scope context + arguments passed to the builder + a **new Job** whose parent is the parent's Job.

> **Under the hood:** A new coroutine always gets its own new `Job`. If you pass a `Job` in the builder arguments, it becomes the **parent** of the new Job, which replaces the normal parent link. That is how `launch(SupervisorJob())` silently breaks structured concurrency.

### Dispatchers

- `Dispatchers.Main`: the Android main thread. For UI work. Needs `kotlinx-coroutines-android`.
- `Dispatchers.Main.immediate`: if you are already on the main thread, runs right away without re-posting to the Looper. Avoids a frame delay. Used by `viewModelScope` and `lifecycleScope`.
- `Dispatchers.Default`: CPU-heavy work (sorting, parsing JSON, diffing). Pool size equals the number of CPU cores, with a minimum of 2.
- `Dispatchers.IO`: blocking I/O (files, blocking network, legacy JDBC). By default up to 64 threads or the number of cores, whichever is larger. Shares threads with `Default`, so switching between them often avoids a real thread switch.
- `Dispatchers.Unconfined`: starts in the caller thread and resumes on whatever thread resumed it. Not for app code. Mostly for special cases and tests.

### limitedParallelism

Creates a view of a dispatcher that runs at most N tasks at once.

```kotlin
// At most 1 at a time: a serial queue, good for confining state
private val dbDispatcher = Dispatchers.IO.limitedParallelism(1)

// A separate budget for a slow legacy SDK, so it cannot starve other IO work
private val legacySdk = Dispatchers.IO.limitedParallelism(4)
```

> **Note:** `Dispatchers.IO.limitedParallelism(n)` is elastic: its threads are on top of the 64-thread IO limit. `Dispatchers.Default.limitedParallelism(n)` never goes beyond Default's own size.

> **Tip:** Main-safety rule from Google: a suspend function should be safe to call from the main thread. The function itself does the `withContext(Dispatchers.IO)`, not the caller. Room and Retrofit suspend functions are already main-safe.

> **Tip:** Inject dispatchers (for example through a constructor parameter) instead of hardcoding `Dispatchers.IO`. This makes testing easy.

## Structured Concurrency and Cancellation

### The Job tree

Every coroutine lives inside a `CoroutineScope`. Each new coroutine's Job is a child of the scope's Job. This makes a tree.

```text
viewModelScope (SupervisorJob)
 ├── launch { loadFeed() }
 │     ├── async { api.posts() }
 │     └── async { api.stories() }
 └── launch { observeSettings() }
```

Rules of structured concurrency:

- A parent does not complete until all its children complete.
- Cancelling a parent cancels all its children.
- If a child fails with a non-cancellation exception, it cancels its parent (unless the parent is a supervisor), which then cancels the other children.
- When the scope dies (ViewModel cleared), everything inside is cancelled. No leaks.

### Job states

| State | isActive | isCompleted | isCancelled |
|---|---|---|---|
| New (lazy) | false | false | false |
| Active | true | false | false |
| Completing | true | false | false |
| Cancelling | false | false | true |
| Cancelled | false | true | true |
| Completed | false | true | false |

"Completing" means the body finished but it is waiting for children.

### Cancellation is cooperative

Calling `job.cancel()` does not kill a thread. It sets the Job to cancelling. The code must check for cancellation. All suspend functions in `kotlinx.coroutines` (like `delay`, `withContext`, `yield`, channel ops) check and throw `CancellationException`.

A tight CPU loop with no suspension points will **not** stop:

```kotlin
val job = launch(Dispatchers.Default) {
    var i = 0
    while (i < 1_000_000_000) { i++ } // ignores cancel()
}
job.cancelAndJoin() // waits for the whole loop
```

Three ways to make it cooperative:

```kotlin
while (isActive) { work() }          // check a flag, exit cleanly

for (item in bigList) {
    ensureActive()                    // throws CancellationException if cancelled
    process(item)
}

for (item in bigList) {
    yield()                           // checks cancellation AND lets others run
    process(item)
}
```

### Cleanup with try/finally

Cancellation throws `CancellationException` at the suspension point, so `finally` blocks run.

```kotlin
launch {
    try {
        repeat(1000) { delay(100) }
    } finally {
        // You are cancelled here. Calling a suspend function would throw again.
        withContext(NonCancellable) {
            repository.saveProgress() // suspend call that must finish
        }
    }
}
```

> **Pitfall:** In a cancelled coroutine, any suspend call inside `finally` throws `CancellationException` immediately. Wrap must-run suspend cleanup in `withContext(NonCancellable)`. Use `NonCancellable` only there, never as a builder argument for normal work.

### CancellationException rules

- It is the normal signal for cancellation. It is not treated as a failure.
- It does not cancel the parent.
- It is not reported to `CoroutineExceptionHandler`.
- **Never swallow it.** If you catch `Exception` or `Throwable`, rethrow `CancellationException`.

```kotlin
try {
    api.call()
} catch (e: CancellationException) {
    throw e                 // keep cancellation working
} catch (e: Exception) {
    showError(e)
}
```

> **Pitfall:** `runCatching { suspendCall() }` catches `CancellationException` too. The coroutine keeps running after it was cancelled. Rethrow it or use a helper that excludes it.

### Timeouts

```kotlin
val data = withTimeoutOrNull(3_000) { api.slowCall() } // null on timeout

try {
    withTimeout(3_000) { api.slowCall() }
} catch (e: TimeoutCancellationException) { /* handle */ }
```

`TimeoutCancellationException` is a subclass of `CancellationException`. If it escapes a `launch`, it is treated as cancellation, not as a crash, which can hide bugs. Prefer `withTimeoutOrNull` or catch it close to the call.

## Exception Handling

### launch vs async

- `launch`: an uncaught exception propagates **up** to the parent right away. If it reaches a root coroutine, it goes to the `CoroutineExceptionHandler` or the thread's uncaught exception handler (crash on Android).
- `async`: the exception is stored in the `Deferred` and thrown at `await()`. But if the `async` is a child of a regular Job, it **also** fails the parent immediately. Wrapping only `await()` in try/catch does not stop that.

```kotlin
// Looks safe, but still crashes the parent scope
scope.launch {
    val d = async { error("boom") }
    try { d.await() } catch (e: Exception) { /* caught, but parent already failing */ }
}

// Correct: isolate with coroutineScope, catch around it
scope.launch {
    try {
        coroutineScope {
            val d = async { error("boom") }
            d.await()
        }
    } catch (e: Exception) { showError(e) }
}
```

### Job vs SupervisorJob

| | Job | SupervisorJob |
|---|---|---|
| Child fails | Parent and all siblings cancelled | Only that child fails |
| Parent cancelled | Children cancelled | Children cancelled |
| Typical use | Tasks that must succeed together | Independent tasks, UI scopes |

### CoroutineExceptionHandler placement

The handler is called only for **uncaught** exceptions in **root** coroutines (or direct children of a supervisor). Rules:

- It works on a `launch` that is a root, i.e. started directly in a scope.
- It does nothing on a nested child of a regular Job. The child passes the exception to its parent, and the parent handles it.
- It does nothing for `async`. The exception goes to the `Deferred`.
- It cannot recover the coroutine. By the time it runs, the coroutine is finished. Use it for logging and showing an error.

```kotlin
val handler = CoroutineExceptionHandler { _, e -> log(e) }

scope.launch(handler) { error("A") }   // handler called

scope.launch {
    launch(handler) { error("B") }      // handler NOT called, goes to parent
}

scope.launch {
    supervisorScope {
        launch(handler) { error("C") }  // handler called: supervisor child acts like a root
    }
}
```

> **Pitfall:** `scope.launch(SupervisorJob()) { launch { fail() }; launch { other() } }` does not give supervisor behaviour to the inner children. The SupervisorJob is the parent of the outer coroutine only. The inner children are children of a normal Job. Also, the new SupervisorJob is detached from the scope, so cancelling the scope will not cancel this work. Use `supervisorScope { }` instead.

> **Interview:** "Where do you put try/catch?" Inside the coroutine, around the code that can fail. A handler is a last resort for logging, not for business errors.

### Multiple failures

If several children fail, the first exception wins. Others are attached as **suppressed** exceptions.

## Android Scopes

### viewModelScope

- Tied to the ViewModel. Cancelled in `onCleared()`.
- Uses `SupervisorJob() + Dispatchers.Main.immediate`.
- Survives configuration changes, because the ViewModel does.

```kotlin
class FeedViewModel(private val repo: FeedRepository) : ViewModel() {
    private val _state = MutableStateFlow(FeedState())
    val state: StateFlow<FeedState> = _state.asStateFlow()

    fun refresh() = viewModelScope.launch {
        _state.update { it.copy(loading = true) }
        val items = repo.load() // main-safe suspend fun
        _state.update { it.copy(loading = false, items = items) }
    }
}
```

### lifecycleScope

- Tied to an Activity or Fragment `Lifecycle`. Cancelled on `DESTROYED`.
- Also `SupervisorJob() + Dispatchers.Main.immediate`.
- In Fragments, use `viewLifecycleOwner.lifecycleScope` for anything that touches views. The Fragment can outlive its view.

### repeatOnLifecycle

Starts a block when the lifecycle reaches a state, and **cancels** it when it drops below. It restarts the block each time the state is reached again.

```kotlin
override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
    viewLifecycleOwner.lifecycleScope.launch {
        viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
            launch { viewModel.state.collect { render(it) } }
            launch { viewModel.events.collect { handle(it) } }
        }
    }
}
```

> **Pitfall:** `lifecycleScope.launch { flow.collect {} }` keeps collecting while the app is in the background. Location or sensor flows keep running and waste battery. Use `repeatOnLifecycle` or `flowWithLifecycle`.

> **Note:** The old `launchWhenStarted` family is deprecated. It only **paused** the coroutine, so upstream producers kept running. `repeatOnLifecycle` cancels and restarts instead.

### Why not GlobalScope

- No parent, so no structured concurrency. Work leaks if the screen goes away.
- No automatic cancellation. Hard to test.
- Exceptions go straight to the uncaught handler.
- It is marked `@DelicateCoroutinesApi`.

For work that must outlive a screen, inject an application-level scope, for example `CoroutineScope(SupervisorJob() + Dispatchers.Default)` created in your DI graph. For work that must survive process death, use WorkManager.

## Thread Safety and Channels

### Shared mutable state

Coroutines on `Default` or `IO` run in parallel on many threads. Plain `var count++` is a race.

Options, from simplest:

1. Avoid shared state. Return values and combine them.
2. Use atomics (`AtomicInteger`) or `MutableStateFlow.update { }`, which is atomic (compare-and-set loop).
3. Confine state to one thread, for example `Dispatchers.Default.limitedParallelism(1)`.
4. Use a `Mutex` for critical sections that suspend.

### Mutex

A `Mutex` is a suspending lock. Waiting coroutines suspend instead of blocking threads.

```kotlin
private val mutex = Mutex()
private var cachedToken: String? = null

suspend fun token(): String = mutex.withLock {
    cachedToken ?: api.refreshToken().also { cachedToken = it }
}
```

> **Pitfall:** `Mutex` is **not reentrant**. Calling `withLock` again on the same mutex from inside the lock deadlocks.

> **Pitfall:** Do not use `synchronized` around code that suspends. The lock is tied to a thread, and the coroutine may resume on a different thread. The compiler blocks suspension calls inside a `synchronized` block for this reason.

### Semaphore

Limits how many coroutines can enter a section at once.

```kotlin
private val semaphore = Semaphore(permits = 3)

suspend fun download(url: String) = semaphore.withPermit {
    http.get(url) // at most 3 downloads at a time
}
```

### Channels

A `Channel` is like a `BlockingQueue`, but with suspending `send` and `receive`. It is **hot** and each value goes to **one** receiver.

| Type | Capacity | send behaviour |
|---|---|---|
| RENDEZVOUS | 0 (default) | Suspends until a receiver takes it |
| BUFFERED | 64 by default | Suspends when buffer is full |
| UNLIMITED | No limit | Never suspends, may run out of memory |
| CONFLATED | 1, keeps latest | Never suspends, overwrites old value |

```kotlin
val channel = Channel<Int>(capacity = Channel.BUFFERED)
launch { for (i in 1..5) channel.send(i); channel.close() }
for (value in channel) println(value) // loop ends when closed
```

You can also set `onBufferOverflow = BufferOverflow.DROP_OLDEST` or `DROP_LATEST` with a capacity.

### produce

`produce` is a builder that returns a `ReceiveChannel` and closes it when the block ends.

```kotlin
fun CoroutineScope.numbers() = produce {
    var x = 1
    while (true) send(x++)
}
```

### Fan-out and fan-in

- **Fan-out:** many coroutines receive from one channel. Work is split; each item goes to one worker.
- **Fan-in:** many coroutines send into one channel.

```kotlin
val jobs = Channel<Task>()
repeat(4) { id -> launch { for (t in jobs) process(id, t) } } // fan-out

val results = Channel<Result>()
launch { results.send(fromCache()) }  // fan-in
launch { results.send(fromNetwork()) }
```

> **Note:** In app code, prefer Flow over raw channels. Channels are a low-level primitive. They show up mostly inside `channelFlow`, `callbackFlow`, actors, and for one-off UI events.

## Flow Fundamentals

A `Flow<T>` is an asynchronous stream of values. It is **cold**: nothing runs until someone calls a terminal operator like `collect`. Each collector gets its own fresh execution.

```kotlin
val numbers: Flow<Int> = flow {
    println("started")
    for (i in 1..3) {
        delay(100)
        emit(i)
    }
}

numbers.collect { println(it) } // prints "started", 1, 2, 3
numbers.collect { println(it) } // runs everything again
```

### Builders

- `flow { emit(x) }`: the general builder. Sequential. Emits only from the same coroutine.
- `flowOf(1, 2, 3)`: fixed values.
- `listOf(1, 2).asFlow()`: from collections, sequences, ranges.
- `channelFlow { }`: can emit from several coroutines at once using `send`. Useful for merging work.
- `callbackFlow { }`: wraps a callback or listener API. Must end with `awaitClose { }`.

```kotlin
fun LocationClient.updates(): Flow<Location> = callbackFlow {
    val listener = LocationListener { loc -> trySend(loc) }
    requestUpdates(listener)
    awaitClose { removeUpdates(listener) } // runs when collector cancels
}
```

> **Pitfall:** Forgetting `awaitClose` in `callbackFlow` causes an `IllegalStateException` when the block finishes. It also means you never unregister the listener.

```kotlin
fun loadAll(ids: List<String>): Flow<Item> = channelFlow {
    ids.forEach { id ->
        launch { send(api.load(id)) } // concurrent emits, allowed here
    }
}
```

### Terminal operators

A terminal operator is a suspend function that starts collection.

| Operator | What it does |
|---|---|
| collect | Runs the flow, handles each value |
| first, firstOrNull | Takes one value then cancels the flow |
| single | Expects exactly one value |
| toList, toSet | Collects everything |
| reduce, fold | Aggregates |
| launchIn(scope) | Shortcut for scope.launch { collect() } |
| count | Counts values |

```kotlin
flow.onEach { render(it) }
    .launchIn(viewModelScope) // returns a Job
```

### Context preservation and flowOn

A flow runs in the context of the **collector**. The `flow { }` block must not switch context itself. Calling `withContext` around `emit` throws an `IllegalStateException` ("Flow invariant is violated").

Use `flowOn` to change the dispatcher of everything **upstream** of it.

```kotlin
repository.items()                // runs on IO
    .map { parse(it) }            // runs on IO
    .flowOn(Dispatchers.IO)
    .map { toUiModel(it) }        // runs on collector's dispatcher
    .collect { render(it) }       // Main
```

> **Under the hood:** `flowOn` creates a channel between the upstream (running in a new coroutine on the new dispatcher) and the downstream. That is why it also adds a buffer.

> **Interview:** "Where does a flow run?" In the collector's coroutine by default. `flowOn` only affects operators above it. Multiple `flowOn` calls each affect their own upstream section.

## Flow Operators

### Transforming

```kotlin
flow.map { it * 2 }
    .filter { it > 10 }
    .mapNotNull { lookup(it) }
    .transform { value ->          // emit zero, one, or many per input
        emit("start $value")
        emit(heavyWork(value))
    }
    .take(5)                       // cancels upstream after 5
```

`onEach` runs a side effect and passes values through. Good for logging.

### Flattening

When each value maps to a new flow, you need a flattening operator.

| Operator | Behaviour | Use case |
|---|---|---|
| flatMapConcat | One inner flow at a time, in order | Ordered steps |
| flatMapMerge | Many inner flows at once (concurrency limit, 16 by default) | Parallel downloads |
| flatMapLatest | Cancels the previous inner flow when a new value arrives | Search, selected item |

```kotlin
val results: Flow<List<Item>> = queryFlow
    .debounce(300)
    .distinctUntilChanged()
    .flatMapLatest { query ->
        if (query.isBlank()) flowOf(emptyList())
        else repository.search(query)
    }
```

### combine vs zip

- `combine(a, b)`: emits whenever **either** flow emits, using the latest value of each. It waits until each has emitted at least once.
- `zip(a, b)`: pairs values one by one. The first of `a` with the first of `b`, and so on. Stops when either ends.

```kotlin
val uiState = combine(userFlow, settingsFlow, cartFlow) { user, settings, cart ->
    UiState(user, settings, cart)
}

val pairs = flowOf(1, 2, 3).zip(flowOf("a", "b")) { n, s -> "$n$s" } // 1a, 2b
```

> **Interview:** For UI state built from several sources, `combine` is almost always right. `zip` is for strict one-to-one pairing.

### Rate limiting and dedupe

- `debounce(300)`: emits a value only if no newer value arrives for 300 ms. Classic search box.
- `sample(1000)`: emits the latest value once per period.
- `distinctUntilChanged()`: skips a value equal to the previous one. `StateFlow` already does this.

### Lifecycle hooks

```kotlin
repository.feed()
    .onStart { emit(FeedState.Loading) }       // before the first upstream value
    .map<List<Post>, FeedState> { FeedState.Data(it) }
    .catch { emit(FeedState.Error(it)) }       // upstream errors only
    .onCompletion { cause -> log("done, cause=$cause") }
```

`onCompletion` gets a `cause`: `null` on normal completion, the exception otherwise (including `CancellationException`). It does not catch the exception.

### Retrying

```kotlin
api.stream()
    .retryWhen { cause, attempt ->
        if (cause is IOException && attempt < 3) {
            delay(1000L * (attempt + 1))  // simple backoff
            true
        } else false
    }
```

`retry(3) { it is IOException }` is the simpler form.

## Backpressure and Errors

### Backpressure

By default, the producer and consumer run sequentially in one coroutine. If `collect` is slow, `emit` waits. That is natural backpressure. To decouple them:

- `buffer()`: run the producer in a separate coroutine with a buffer. Both run at the same time.
- `conflate()`: keep only the latest value. A slow collector skips old ones.
- `collectLatest { }`: when a new value arrives, cancel the work for the previous one.

```kotlin
// Producer: 100 ms per item. Collector: 300 ms per item.
flow.collect { slow(it) }           // ~400 ms per item, sequential
flow.buffer().collect { slow(it) }  // ~300 ms per item, overlapped
flow.conflate().collect { slow(it) } // skips stale items
flow.collectLatest { slow(it) }     // only the last item completes fully
```

`buffer` also accepts a capacity and an `onBufferOverflow` strategy, the same as channels. `conflate()` is the same as `buffer(CONFLATED)`.

### Exception transparency

A flow must not hide exceptions from downstream. Rules:

- Do not wrap `emit` in `try/catch` inside a `flow { }` builder. If the collector throws, you would catch the collector's exception and then try to emit again, which breaks the contract.
- Use the `catch` operator. It catches only exceptions from **upstream** of it, never from downstream (including `collect`).

```kotlin
flow { emit(1); throw IOException() }
    .catch { e -> emit(-1) }         // catches the IOException
    .collect { value ->
        check(value > 0)             // NOT caught by catch above
    }
```

To catch errors thrown inside the collector too, move the logic into `onEach` and put `catch` after it:

```kotlin
flow.onEach { value -> handle(value) }
    .catch { e -> showError(e) }
    .launchIn(scope)
```

> **Pitfall:** After `catch`, the original flow is **done**. `catch` cannot resume it. To keep a long-lived stream alive after an error, catch inside the inner flow (for example inside `flatMapLatest`), or use `retry`.

## StateFlow and SharedFlow

Regular flows are cold. `StateFlow` and `SharedFlow` are **hot**: they exist and hold or emit values independently of collectors, and many collectors share them.

### StateFlow

- Always has a value. Needs an initial value.
- New collectors get the current value right away.
- **Conflated**: slow collectors only see the latest value.
- **Equality-based dedupe**: setting a value that `equals` the current one does nothing.
- Read and write with `value`. Update safely with `update { }`.

```kotlin
private val _state = MutableStateFlow(UiState())
val state: StateFlow<UiState> = _state.asStateFlow()

fun onNameChanged(name: String) {
    _state.update { it.copy(name = name) } // atomic read-modify-write
}
```

> **Pitfall:** `_state.value = _state.value.copy(...)` from several coroutines can lose updates. Use `update { }`.

> **Pitfall:** Mutating a list inside the state and re-setting the same list instance emits nothing. Equality says "same". Always use immutable data and create new instances.

### SharedFlow

A configurable hot stream. No initial value required.

```kotlin
val events = MutableSharedFlow<Event>(
    replay = 0,                 // values replayed to new subscribers
    extraBufferCapacity = 64,   // extra room beyond replay
    onBufferOverflow = BufferOverflow.SUSPEND // or DROP_OLDEST, DROP_LATEST
)
```

- `replay`: how many past values a new collector gets.
- `extraBufferCapacity`: buffer for fast emitters so `emit` does not suspend and `tryEmit` can succeed.
- `onBufferOverflow`: what to do when the buffer is full. `SUSPEND` makes `emit` wait.
- With the defaults (`replay = 0`, no extra buffer), `tryEmit` fails when there are subscribers, because there is nowhere to put the value.

> **Under the hood:** A `MutableStateFlow(initial)` behaves like `MutableSharedFlow(replay = 1, onBufferOverflow = DROP_OLDEST)` with the initial value emitted, plus `distinctUntilChanged`. StateFlow is a special, simpler SharedFlow.

### Comparison

| Feature | StateFlow | SharedFlow | LiveData |
|---|---|---|---|
| Initial value | Required | Not needed | Optional |
| Replay | Always the latest 1 | Configurable 0..n | Latest 1 |
| Dedupe | Yes, by equals | No | No |
| Lifecycle aware | No, collect with repeatOnLifecycle | No | Yes |
| Operators | Full Flow API | Full Flow API | Few (map, switchMap) |
| Pure Kotlin, KMP | Yes | Yes | No, Android only |
| Threading | Thread-safe from any thread | Thread-safe | setValue main only, postValue any |

> **Interview:** "Why StateFlow over LiveData?" Full operator set, works in pure Kotlin modules and KMP, built-in equality dedupe, and consistent with the rest of a coroutine-based data layer. LiveData's one advantage, lifecycle awareness, is covered by `collectAsStateWithLifecycle` and `repeatOnLifecycle`.

### stateIn and shareIn

Turn a cold flow into a hot one shared by all collectors.

```kotlin
val uiState: StateFlow<UiState> = combine(repo.user(), repo.settings()) { u, s ->
    UiState(u, s)
}.stateIn(
    scope = viewModelScope,
    started = SharingStarted.WhileSubscribed(5_000),
    initialValue = UiState.Loading
)

val ticks: SharedFlow<Tick> = tickerFlow()
    .shareIn(viewModelScope, SharingStarted.Eagerly, replay = 1)
```

`SharingStarted` options:

- `Eagerly`: starts now, never stops (until the scope ends).
- `Lazily`: starts at the first subscriber, never stops.
- `WhileSubscribed(stopTimeoutMillis)`: starts at the first subscriber, stops after the last one leaves and the timeout passes.

### Why WhileSubscribed(5000)

- When the app goes to the background, the UI stops collecting. After 5 seconds the upstream (database query, location, network polling) is stopped. Saves resources.
- On a configuration change (rotation), the Activity is destroyed and recreated in well under 5 seconds. The upstream keeps running, so there is no restart and no repeated network call.
- 5 seconds is a common default, also below the ANR threshold, so it reads as "survive a rotation, not a long trip to the background".

> **Pitfall:** Calling `stateIn` inside a function or getter, for example `fun state() = flow.stateIn(...)`, creates a new shared flow on every call. Assign it once to a property.

### Collecting safely in UI

In Compose, use `collectAsStateWithLifecycle` from `androidx.lifecycle:lifecycle-runtime-compose`. It stops collecting when the lifecycle drops below `STARTED`.

```kotlin
@Composable
fun FeedRoute(viewModel: FeedViewModel = viewModel()) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    FeedScreen(state)
}
```

`collectAsState()` keeps collecting in the background. Prefer the lifecycle version on Android.

In Views, use `repeatOnLifecycle(STARTED)` as shown in the Android Scopes section, or `flow.flowWithLifecycle(lifecycle)` for a single flow.

### One-off events: the debate

Events like "show a snackbar" or "navigate to details" must be handled exactly once.

| Approach | Pros | Cons |
|---|---|---|
| Channel + receiveAsFlow | Buffers events while no one collects | Can still drop an event in a narrow window during lifecycle changes; one collector only |
| SharedFlow replay 0 | Simple, many collectors | Events emitted with no collector are lost |
| Event in UI state | Survives config changes and process death if saved | UI must tell the ViewModel the event was consumed |

```kotlin
// Option 1: Channel
private val _events = Channel<Event>(Channel.BUFFERED)
val events = _events.receiveAsFlow()

// Option 3: state-based (Google's current guidance)
data class UiState(val userMessage: String? = null)
fun messageShown() = _state.update { it.copy(userMessage = null) }
```

Google's Android architecture guidance recommends modelling events as **state** and having the UI report back when it handled them. Many teams still use a `Channel` and accept the small risk. In an interview, explain the trade-offs rather than claiming one is perfect.

> **Tip:** If you use a Channel for events, collect it on `Dispatchers.Main.immediate` (the default for `lifecycleScope`) to shrink the window where an event can be lost.

## Testing Coroutines and Flow

Add `kotlinx-coroutines-test`. Optionally add `app.cash.turbine:turbine` for flows.

### runTest

`runTest` runs a test body in a coroutine with **virtual time**. `delay` does not actually wait. It also fails the test if coroutines are left running or exceptions are unhandled.

```kotlin
@Test
fun `loads after delay`() = runTest {
    val repo = FakeRepo(delayMs = 10_000)
    val result = repo.load()       // finishes instantly in real time
    assertEquals(expected, result)
    println(currentTime)           // 10000 virtual ms
}
```

### Test dispatchers

| Dispatcher | Behaviour |
|---|---|
| StandardTestDispatcher | Queues new coroutines. They run only when the test yields or advances the scheduler. Default in runTest. |
| UnconfinedTestDispatcher | Starts new coroutines eagerly, like Unconfined. Simpler, but hides ordering issues. |

Scheduler controls:

- `advanceUntilIdle()`: run everything queued, including delays, until nothing is left.
- `advanceTimeBy(ms)`: move virtual time forward. Tasks scheduled exactly at the new time do not run yet.
- `runCurrent()`: run tasks scheduled at the current time.

```kotlin
@Test
fun standardDispatcherNeedsAdvancing() = runTest {
    var done = false
    launch { done = true }
    assertFalse(done)     // not run yet
    advanceUntilIdle()
    assertTrue(done)
}
```

### Dispatchers.setMain

`viewModelScope` uses `Dispatchers.Main`, which does not exist in local JVM tests. Replace it.

```kotlin
class MainDispatcherRule(
    val dispatcher: TestDispatcher = UnconfinedTestDispatcher()
) : TestWatcher() {
    override fun starting(description: Description) = Dispatchers.setMain(dispatcher)
    override fun finished(description: Description) = Dispatchers.resetMain()
}
```

If `Main` is set to a `TestDispatcher`, `runTest` and other test dispatchers created later share its scheduler. That keeps virtual time consistent.

> **Tip:** Inject `CoroutineDispatcher`s into repositories. In tests, pass the test dispatcher instead of `Dispatchers.IO`, so all work runs on the shared scheduler.

### Testing a ViewModel

```kotlin
class FeedViewModelTest {
    @get:Rule val mainRule = MainDispatcherRule()

    @Test
    fun refreshUpdatesState() = runTest {
        val vm = FeedViewModel(FakeFeedRepo(listOf(post)))
        vm.refresh()
        advanceUntilIdle()
        assertEquals(listOf(post), vm.state.value.items)
    }
}
```

### Testing flows with Turbine

```kotlin
@Test
fun emitsLoadingThenData() = runTest {
    viewModel.uiState.test {
        assertEquals(UiState.Loading, awaitItem())
        assertEquals(UiState.Data(items), awaitItem())
        cancelAndIgnoreRemainingEvents()
    }
}
```

Without Turbine, collect in `backgroundScope` so the collector is cancelled at the end of the test:

```kotlin
@Test
fun stateInNeedsASubscriber() = runTest {
    val values = mutableListOf<UiState>()
    backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
        viewModel.uiState.toList(values)
    }
    viewModel.refresh()
    advanceUntilIdle()
    assertEquals(UiState.Data(items), values.last())
}
```

> **Pitfall:** A `stateIn(WhileSubscribed)` flow does not run its upstream until someone collects. Reading `.value` in a test without a collector returns only the initial value.

> **Note:** StateFlow conflates. If a test emits several values quickly, a collector may see only the last one. Test the final state, or use `SharedFlow` when every value matters.

## Common Pitfalls

1. **Blocking inside a coroutine.** `Thread.sleep`, blocking I/O, or heavy CPU work on `Dispatchers.Main` freezes the UI. Use `delay`, suspend APIs, and the right dispatcher.
2. **Swallowing CancellationException.** `catch (e: Exception)` or `runCatching` around suspend calls keeps a cancelled coroutine alive. Rethrow it.
3. **Passing a Job to a builder.** `launch(Job())` or `launch(SupervisorJob())` breaks the link to the parent. Cancellation of the scope no longer reaches it.
4. **Handler on a child.** `CoroutineExceptionHandler` on a nested `launch` is ignored. Install it on the root or the scope.
5. **try/catch only around await.** The failing `async` already cancelled its parent. Wrap the whole `coroutineScope`.
6. **GlobalScope.** Leaks work and makes tests hard. Use an injected app scope.
7. **Collecting in lifecycleScope without repeatOnLifecycle.** Upstream keeps running in the background.
8. **Creating stateIn in a getter.** A new upstream per call. Store it in a `val`.
9. **Mutating state in place.** StateFlow sees an equal object and emits nothing. Use immutable copies.
10. **withContext inside flow { }.** Violates context preservation. Use `flowOn`.
11. **try/catch around emit.** Breaks exception transparency. Use `catch`.
12. **Sequential async.** `async { a() }.await(); async { b() }.await()` is not parallel.
13. **Non-cooperative loops.** CPU loops without `ensureActive` or `yield` ignore cancellation.
14. **Suspend calls in finally after cancel.** They throw immediately. Use `withContext(NonCancellable)`.
15. **Mutex reentrancy.** Locking the same `Mutex` twice in one call chain deadlocks.
16. **runBlocking on main.** Can freeze the app and cause ANRs.

## Interview Questions

### Q: What is the difference between a coroutine and a thread?

A thread is an OS resource with its own stack, and blocking it wastes that resource. A coroutine is a suspendable computation that runs on a thread but can pause without blocking it. Many coroutines share few threads, so they are much cheaper. Coroutines also have structured lifetimes and built-in cancellation.

### Q: How does a suspend function work under the hood?

The compiler applies a CPS transformation. It adds a `Continuation` parameter and changes the return type to `Any?`. The body becomes a state machine with a `label` field and saved locals. At each suspension point, if the callee returns `COROUTINE_SUSPENDED`, the function returns that marker up the stack. Later, `resumeWith` re-enters the function at the saved label.

### Q: launch vs async?

`launch` returns a `Job` and is for side effects. `async` returns a `Deferred<T>` and is for computing a result, usually in parallel. In `launch`, uncaught exceptions propagate to the parent right away. In `async`, the exception is thrown at `await()`, but a child `async` still fails its parent immediately.

### Q: coroutineScope vs supervisorScope?

Both wait for all children. In `coroutineScope`, one child's failure cancels all siblings and the exception is rethrown. In `supervisorScope`, children fail independently, and each failing `launch` child reports to the exception handler in its context.

### Q: What is structured concurrency?

Every coroutine has a parent scope. Parents wait for children, cancellation flows down, and failures flow up. This guarantees no leaked work and no lost errors when a scope like `viewModelScope` ends.

### Q: How does cancellation work?

It is cooperative. `cancel()` marks the Job as cancelling. Suspend functions from the library check this and throw `CancellationException`. CPU-bound code must check `isActive`, call `ensureActive()`, or call `yield()`. Cleanup goes in `finally`, and suspend cleanup needs `withContext(NonCancellable)`.

### Q: Why should you not catch CancellationException?

It is the signal that stops the coroutine. If you swallow it, the coroutine keeps running after its scope was cancelled. That can update dead UI, waste resources, or break structured concurrency. Always rethrow it.

### Q: When is CoroutineExceptionHandler called?

Only for uncaught exceptions in root coroutines started with `launch`, or direct children of a supervisor. It is ignored on nested children of a regular Job and is never used for `async`. It is for logging, not recovery.

### Q: Dispatchers.IO vs Dispatchers.Default?

`Default` is for CPU-bound work and has as many threads as cores. `IO` is for blocking I/O and allows many more threads (64 by default) because those threads mostly wait. They share a thread pool, so switching between them is cheap.

### Q: What does Dispatchers.Main.immediate do?

If the code is already on the main thread, it runs right away instead of posting to the main Looper queue. This avoids an extra frame of delay. `viewModelScope` and `lifecycleScope` use it.

### Q: Cold vs hot flows?

A cold flow (`flow { }`) runs its producer for each collector, starting at `collect`. A hot flow (`StateFlow`, `SharedFlow`) exists independently of collectors and shares emissions among all of them.

### Q: StateFlow vs SharedFlow?

StateFlow always has one current value, needs an initial value, conflates, and skips equal values. SharedFlow is configurable: replay count, extra buffer, overflow strategy, and no dedupe. Use StateFlow for state and SharedFlow for broadcasts or events.

### Q: Why use WhileSubscribed(5000) with stateIn?

It stops the upstream 5 seconds after the last collector leaves. Going to the background stops expensive work, but a quick configuration change does not restart it.

### Q: flatMapLatest vs flatMapMerge vs flatMapConcat?

`flatMapConcat` runs inner flows one after another. `flatMapMerge` runs them concurrently. `flatMapLatest` cancels the previous inner flow when a new value arrives, which is right for search queries or a selected ID.

### Q: What is exception transparency in Flow?

A flow must not catch exceptions coming from downstream. So you do not wrap `emit` in try/catch. The `catch` operator only handles upstream exceptions. To handle collector errors, move logic into `onEach` before `catch`.

### Q: How do you test a ViewModel that uses viewModelScope?

Replace `Dispatchers.Main` with a `TestDispatcher` using `Dispatchers.setMain`, usually via a JUnit rule. Use `runTest` for virtual time. Use `advanceUntilIdle()` with `StandardTestDispatcher`, and Turbine or a `backgroundScope` collector for flows. Inject other dispatchers so they share the test scheduler.

### Q: How do you handle one-off UI events?

Options are a `Channel` exposed with `receiveAsFlow`, a `SharedFlow` with no replay, or modelling the event as state that the UI clears after handling. Google recommends the state approach because it cannot be lost. Channels are common but can drop events in rare lifecycle windows. SharedFlow without a collector loses events.

## Cheat Sheet and Practice

### Cheat sheet

```text
BUILDERS     launch -> Job | async -> Deferred.await() | runBlocking (not on main)
SCOPES       coroutineScope (fail together) | supervisorScope (fail alone)
SWITCH       withContext(IO) { } -> result, main-safe functions
CONTEXT      Job + Dispatcher + CoroutineName + Handler, "+" right side wins
DISPATCHERS  Main / Main.immediate / Default (cores) / IO (64+) / Unconfined
             limitedParallelism(1) = serial queue
CANCEL       cooperative: isActive, ensureActive(), yield()
             finally + withContext(NonCancellable) for suspend cleanup
             never swallow CancellationException (watch runCatching)
ERRORS       launch: propagates up | async: at await AND fails parent
             handler only on root launch / supervisor child
             launch(SupervisorJob()) is a trap -> use supervisorScope
ANDROID      viewModelScope, lifecycleScope = SupervisorJob + Main.immediate
             repeatOnLifecycle(STARTED), collectAsStateWithLifecycle
             no GlobalScope -> injected app scope or WorkManager
SYNC         Mutex.withLock (not reentrant), Semaphore.withPermit
             MutableStateFlow.update { } is atomic
CHANNELS     RENDEZVOUS 0 | BUFFERED 64 | UNLIMITED | CONFLATED
FLOW         cold, runs in collector context, flowOn changes UPSTREAM
             callbackFlow needs awaitClose, channelFlow for concurrent send
OPERATORS    flatMapLatest (search), combine (latest of all), zip (pairs)
             debounce, distinctUntilChanged, catch (upstream only), retryWhen
BACKPRESSURE buffer | conflate | collectLatest
HOT          StateFlow: initial, conflated, equals-dedupe
             SharedFlow: replay, extraBufferCapacity, onBufferOverflow
             stateIn(scope, WhileSubscribed(5000), initial) in a val
TEST         runTest (virtual time), StandardTestDispatcher + advanceUntilIdle
             Dispatchers.setMain / resetMain, Turbine test { awaitItem() }
```

### Practice exercises

1. **Parallel dashboard.** Write `suspend fun loadDashboard(): Dashboard` that loads profile, notifications, and recommendations in parallel. If recommendations fail, show the rest with an empty list. If profile fails, the whole call must fail. Hint: mix `coroutineScope`, `async`, and a local try/catch or `supervisorScope`.
2. **Search screen.** Build a ViewModel with a `MutableStateFlow<String>` query. Expose `StateFlow<SearchUiState>` using `debounce(300)`, `distinctUntilChanged`, `flatMapLatest`, `catch` inside the inner flow, and `stateIn(WhileSubscribed(5000))`. Write a Turbine test that proves only the last query hits the repository.
3. **Wrap a listener.** Convert a callback-based connectivity listener into a `Flow<Boolean>` with `callbackFlow`. Make sure the listener is unregistered when the collector is cancelled. Test it with a fake that counts register and unregister calls.
4. **Token refresh race.** Ten coroutines call `getToken()` at the same time when the token is expired. Make sure only one network refresh happens. Use `Mutex`. Then explain why `synchronized` is wrong here.
5. **Cancellation audit.** Take a function that parses a large file in a `for` loop on `Dispatchers.Default` and catches `Exception` to log errors. Fix it so that it stops quickly on cancel, never swallows `CancellationException`, and always closes the file. Write a `runTest` test that cancels it halfway and checks the file was closed.

### References

- [Coroutines guide (Kotlin docs)](https://kotlinlang.org/docs/coroutines-guide.html)
- [Coroutine context and dispatchers](https://kotlinlang.org/docs/coroutine-context-and-dispatchers.html)
- [Cancellation and timeouts](https://kotlinlang.org/docs/cancellation-and-timeouts.html)
- [Coroutine exceptions handling](https://kotlinlang.org/docs/exception-handling.html)
- [Asynchronous Flow](https://kotlinlang.org/docs/flow.html)
- [Shared mutable state and concurrency](https://kotlinlang.org/docs/shared-mutable-state-and-concurrency.html)
- [Channels](https://kotlinlang.org/docs/channels.html)
- [kotlinx.coroutines API reference](https://kotlinlang.org/api/kotlinx.coroutines/)
- [Kotlin coroutines on Android](https://developer.android.com/kotlin/coroutines)
- [Best practices for coroutines in Android](https://developer.android.com/kotlin/coroutines/coroutines-best-practices)
- [StateFlow and SharedFlow on Android](https://developer.android.com/kotlin/flow/stateflow-and-sharedflow)
- [Testing Kotlin coroutines on Android](https://developer.android.com/kotlin/coroutines/test)
- [UI events (Android architecture guide)](https://developer.android.com/topic/architecture/ui-layer/events)
- [Turbine on GitHub](https://github.com/cashapp/turbine)
