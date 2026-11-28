## Why coroutines

What problem coroutines solve on Android, and why "suspend, not block" is the idea everything else builds on.

:::tldr
- A coroutine is work that can pause without blocking its thread and resume later, maybe on another thread.
- Coroutines are cheap objects on the heap; threads are expensive OS resources.
- You get sequential-looking async code, built-in cancellation, and lifetimes tied to a scope.
:::

### The problem

Android draws the UI on one main thread. If that thread is busy, frames drop. If it is blocked for about 5 seconds, the user sees an ANR dialog. Network calls on the main thread throw `NetworkOnMainThreadException`.

So slow work must run somewhere else, and the result must come back to the main thread. Before coroutines, we had three tools:

- **Callbacks.** Simple at first, but they nest badly. Error handling and cancellation are manual at every level.
- **RxJava.** Powerful, but a big API with its own learning curve.
- **Raw threads or executors.** Expensive, and nothing ties their lifetime to a screen.

```kotlin
// Callback style: nesting grows with every step
auth.getToken { token ->
    api.fetchUser(token) { user ->
        runOnUiThread { show(user) }
    }
}

// Coroutine style: reads top to bottom
viewModelScope.launch {
    val token = auth.getToken()
    val user = api.fetchUser(token)
    show(user)
}
```

### What a coroutine is

A coroutine is a piece of work that can **suspend** (pause) without blocking a thread. Later it **resumes**, maybe on a different thread. Many coroutines share a small pool of threads.

The key phrase is **suspend, not block**. `Thread.sleep(1000)` holds the thread hostage for a second. `delay(1000)` gives the thread back and asks to be resumed later. Other coroutines use the thread in the meantime.

### Threads vs coroutines

| Aspect | Thread | Coroutine |
|---|---|---|
| Cost | Around 1 MB of stack, managed by the OS | A small object on the heap |
| How many | Thousands at most | Hundreds of thousands is fine |
| Waiting | Blocks the thread | Suspends, frees the thread |
| Switching | OS context switch | Function returns, later resumes |
| Cancellation | Manual flags or interrupt | Built in and cooperative |
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
// 100_000 threads that each sleep 1s: likely OutOfMemoryError
```

> **Interview:** Coroutines are often called "lightweight threads", but strictly they are suspendable computations that run on threads. A dispatcher decides which thread runs them.

### What you get

- Sequential-looking async code. No callback pyramid.
- Normal `try/catch` for errors, and exceptions that propagate like normal exceptions.
- **Structured concurrency.** Every coroutine belongs to a scope, so work cannot leak.
- Built-in cancellation that flows down from parent to children.
- First-class Jetpack support: `viewModelScope`, `lifecycleScope`, Room, Retrofit, DataStore, Paging and `CoroutineWorker`.

> **Note:** Coroutines do not make code run faster by themselves. They make waiting cheap and concurrency easy to write and to cancel.

:::deeper Language vs library
Coroutines come in two layers.

- The **Kotlin language and stdlib** give you the `suspend` keyword, `Continuation`, and low-level helpers like `suspendCoroutine`.
- The **kotlinx.coroutines library** gives you everything you use day to day: `launch`, `async`, `Job`, dispatchers, `Flow`, `Channel`, `Mutex` and the test tools.

On Android you also add `kotlinx-coroutines-android`, which provides `Dispatchers.Main`.
:::

:::check
Q: Predict the output: `runBlocking { launch { delay(100); println("A") }; println("B") }`.
A: `B` then `A`. `launch` starts a new coroutine and returns at once, so `println("B")` runs first; `A` prints after the delay.
Q: A coroutine on `Dispatchers.Main` calls `Thread.sleep(2000)`. Another calls `delay(2000)`. Which one freezes the UI?
A: `Thread.sleep` blocks the main thread, so the UI freezes. `delay` suspends and frees the thread, so the UI stays smooth.
Q: Interview: What is the difference between a coroutine and a thread?
A: A thread is an OS resource with its own stack, and blocking it wastes that resource. A coroutine is a suspendable computation that runs on threads and pauses without blocking, so many coroutines share few threads; it also has a structured lifetime and built-in cancellation.
:::

## Suspend under the hood

How the compiler turns a `suspend` function into a state machine, and how to wrap a callback API yourself.

:::tldr
- The compiler adds a hidden `Continuation` parameter and makes the function return `Any?` (CPS).
- The body becomes a state machine: a `label` says where to resume and fields hold the locals.
- `suspendCancellableCoroutine` is the bridge from callback APIs to suspend functions.
:::

### What suspend means

A `suspend` function can pause. You can only call it from another suspend function or from inside a coroutine.

```kotlin
suspend fun loadUser(id: String): User {
    val token = auth.getToken()          // may suspend
    val user = api.fetchUser(id, token)  // may suspend
    return user
}
```

`suspend` means "may suspend", not "will suspend". If the data is already in a cache, the function just returns the value. No thread hop happens.

### CPS transformation

The compiler rewrites every suspend function in **Continuation-Passing Style (CPS)**. It adds a hidden last parameter of type `Continuation<T>` and changes the return type to `Any?`.

```kotlin
// What you write
suspend fun loadUser(id: String): User

// Roughly what the JVM sees
fun loadUser(id: String, completion: Continuation<User>): Any?
```

The `Any?` return is either the real result or a special marker, `COROUTINE_SUSPENDED`. The marker means "I paused. I will call your continuation later."

```kotlin
public interface Continuation<in T> {
    public val context: CoroutineContext
    public fun resumeWith(result: Result<T>)
}
```

A continuation is "the rest of the computation". When the async work finishes, someone calls `resumeWith`, and the function continues where it left off.

> **Interview:** This is why you cannot call a suspend function from a normal function. A normal function has no continuation to pass. A builder like `launch` creates the first one.

### The state machine

Each suspension point becomes a state. The compiler generates a continuation class that stores the local variables and an int `label` that says where to resume. Here is a simplified sketch, not exact bytecode:

```kotlin
fun loadUser(id: String, completion: Continuation<User>): Any? {
    val sm = completion as? LoadUserSM ?: LoadUserSM(completion)
    when (sm.label) {
        0 -> {
            sm.id = id
            sm.label = 1
            val r = auth.getToken(sm)        // pass ourselves as continuation
            if (r === COROUTINE_SUSPENDED) return COROUTINE_SUSPENDED
            sm.result = r
        }
        1 -> { /* resumed: token is in sm.result */ }
    }
    val token = sm.result as String
    sm.label = 2
    return api.fetchUser(sm.id!!, token, sm) // result or SUSPENDED
}
```

What happens at runtime:

1. First call: label is 0. It calls `getToken` and passes its state machine as the continuation.
2. If `getToken` suspends, it returns `COROUTINE_SUSPENDED`. Every caller returns it too, all the way up. The thread is now free.
3. When the token arrives, `resumeWith` is called on the state machine. It re-enters `loadUser` with label 1.
4. The locals were saved in fields, so the function continues as if it never left.

> **Under the hood:** The state-machine object is allocated once per call, not once per suspension point. It is reused for every pause in that call. This is a big reason coroutines are cheap compared to threads with full stacks.

### Wrapping a callback API

`suspendCancellableCoroutine` suspends the coroutine and hands you a continuation to resume from a callback.

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

> **Tip:** Prefer `suspendCancellableCoroutine` over the stdlib `suspendCoroutine`. It supports cancellation and lets you clean up the underlying resource.

> **Pitfall:** Resume a continuation only once. Resuming twice throws `IllegalStateException`. For a callback that fires many times, use `callbackFlow` instead.

:::deeper The generated continuation class
The class behind the sketch looks roughly like this:

```kotlin
class LoadUserSM(completion: Continuation<User>) : ContinuationImpl(completion) {
    var label = 0
    var id: String? = null
    var result: Any? = null

    override fun invokeSuspend(result: Any?): Any? {
        this.result = result
        return loadUser(id!!, this) // re-enter at the saved label
    }
}
```

- `ContinuationImpl.resumeWith` calls `invokeSuspend`. When it gets a real result, it resumes the caller's continuation (`completion`).
- The chain of `completion` references is the "virtual stack" of suspended calls. It lives on the heap, not on a thread stack.
- `ContinuationImpl` also asks the dispatcher in the context to resume on the right thread.
:::

:::check
Q: A suspend function checks an in-memory cache, finds the value, and returns it. Did it suspend?
A: No. It returned the value directly instead of `COROUTINE_SUSPENDED`. `suspend` only marks that a function may pause.
Q: Why can a callback resumed with `cont.resume(x)` on a background thread still continue your coroutine on the main thread?
A: Resumption goes through the dispatcher in the coroutine's context. If the coroutine runs on `Dispatchers.Main`, the rest of the code is posted back to the main thread.
Q: Interview: How does a suspend function work under the hood?
A: The compiler adds a `Continuation` parameter and returns `Any?`, then turns the body into a state machine with a `label` and saved locals. At each suspension point, if the callee returns `COROUTINE_SUSPENDED`, the function returns that marker; later `resumeWith` re-enters at the saved label.
:::

## Builders

The functions that start coroutines or open nested scopes, and when to pick each one.

:::tldr
- `launch` is fire and forget (returns a `Job`); `async` returns a `Deferred` for a result, usually in parallel.
- `coroutineScope` and `supervisorScope` open a child scope inside a suspend function and wait for all children.
- `withContext` switches the dispatcher for a block and returns its result; `runBlocking` blocks a thread and is never for the main thread.
:::

### launch

`launch` starts a coroutine for a side effect. It returns a `Job` and no result.

```kotlin
val job: Job = scope.launch {
    repository.refresh()
}
job.cancel() // you can cancel it later
```

### async and await

`async` returns a `Deferred<T>`. It is a `Job` that also carries a result. Use it to run work in parallel.

```kotlin
suspend fun loadScreen(): Screen = coroutineScope {
    val user = async { api.user() }
    val feed = async { api.feed() }
    Screen(user.await(), feed.await()) // both ran in parallel
}
```

If each call takes 1 second, this takes about 1 second, not 2.

> **Pitfall:** `async { a() }.await()` followed by `async { b() }.await()` is sequential code with extra cost. Start all the `async` calls first, then await them.

`async(start = CoroutineStart.LAZY)` does not run until you call `start()` or `await()`. The same option exists for `launch`.

### runBlocking

`runBlocking` blocks the current thread until the coroutine inside finishes. It bridges the blocking world and the suspending world.

- Fine in a `main()` function, scripts and some library bridges.
- Never use it on the Android main thread. It freezes the UI and can cause an ANR.
- In tests, use `runTest` instead.

### coroutineScope

`coroutineScope` creates a child scope and suspends until all its children finish. If one child fails, the others are cancelled and the exception is rethrown to the caller.

```kotlin
suspend fun syncAll() = coroutineScope {
    launch { syncContacts() }
    launch { syncPhotos() }
} // returns only when both are done
```

This is the normal way to start parallel work from inside a suspend function. It needs no outside scope, so it cannot leak.

### supervisorScope

Same as `coroutineScope`, but a failing child does **not** cancel its siblings. Use it when tasks are independent.

```kotlin
suspend fun loadWidgets() = supervisorScope {
    launch { loadWeather() } // can fail alone
    launch { loadNews() }    // keeps running
}
```

### withContext

`withContext` runs a block with a different context, usually a different dispatcher. It suspends the caller until the block is done, then returns its result.

```kotlin
suspend fun readFile(path: String): String = withContext(Dispatchers.IO) {
    File(path).readText()
}
```

### Summary

| Builder | Returns | Caller waits? | Typical use |
|---|---|---|---|
| `launch` | `Job` | No | Side effects |
| `async` | `Deferred<T>` | Only at `await()` | Parallel results |
| `runBlocking` | `T` | Blocks the thread | `main`, scripts |
| `coroutineScope` | `T` | Suspends | Parallel work in a suspend fun |
| `supervisorScope` | `T` | Suspends | Independent children |
| `withContext` | `T` | Suspends | Switch dispatcher |

`launch` and `async` are extensions on `CoroutineScope`. You need a scope to call them. The other four are plain functions.

> **Interview:** `withContext` vs `async { }.await()`: both run a block elsewhere and give a result. `withContext` is simpler and cheaper for one result on another dispatcher. Use `async` only when you need parallelism.

:::check
Q: `val a = async { delay(1000); 1 }.await(); val b = async { delay(1000); 2 }.await()`. About how long does this take, and how do you fix it?
A: About 2 seconds, because each `await` runs before the next `async` starts. Start both with `async` first, then await both, to get about 1 second.
Q: You need one value from disk inside a ViewModel coroutine. `withContext(Dispatchers.IO)` or `async(Dispatchers.IO) { }.await()`?
A: `withContext`. It does the same job with less overhead and clearer intent; `async` is for running several things at once.
Q: Interview: What is the difference between `coroutineScope` and `supervisorScope`?
A: Both wait for all children. In `coroutineScope`, one child's failure cancels the siblings and the exception is rethrown. In `supervisorScope`, children fail independently, and each failing `launch` child reports to the exception handler in its context.
:::

## Context and dispatchers

What a `CoroutineContext` holds, how contexts combine, and which dispatcher to use for which job.

:::tldr
- A context is a set of elements keyed by type: `Job`, dispatcher, `CoroutineName`, `CoroutineExceptionHandler`.
- `+` combines contexts and the right side wins; every new coroutine gets a new `Job`.
- `Main` for UI, `Default` for CPU work, `IO` for blocking I/O; make suspend functions main-safe.
:::

### The main elements

Every coroutine has a `CoroutineContext`. It is an indexed set of **elements**, keyed by their type.

| Element | Purpose |
|---|---|
| `Job` | Lifecycle, cancellation, parent and child links |
| `CoroutineDispatcher` | Which thread or pool runs the code |
| `CoroutineName` | A name for debugging and logs |
| `CoroutineExceptionHandler` | Last-resort handler for uncaught exceptions |

### The + operator

Contexts combine with `+`. If two elements have the same key, the right side wins.

```kotlin
val ctx = Dispatchers.IO + CoroutineName("sync") + handler
val ctx2 = ctx + Dispatchers.Default // dispatcher replaced, name kept

scope.launch(CoroutineName("refresh")) {
    println(coroutineContext[CoroutineName]) // CoroutineName(refresh)
    println(coroutineContext[Job])           // this coroutine's Job
}
```

A new coroutine's context is: the scope's context, plus the arguments you pass to the builder, plus a **new `Job`** whose parent is the scope's `Job`.

> **Under the hood:** If you pass a `Job` as a builder argument, it becomes the parent of the new coroutine's `Job` instead of the scope's `Job`. That is how `launch(SupervisorJob())` or `launch(Job())` silently breaks structured concurrency.

### Dispatchers

- `Dispatchers.Main`: the Android main thread, for UI work. Needs `kotlinx-coroutines-android`.
- `Dispatchers.Main.immediate`: if you are already on the main thread, it runs the code right away instead of posting it to the main Looper. This avoids a frame of delay. `viewModelScope` and `lifecycleScope` use it.
- `Dispatchers.Default`: CPU-heavy work like sorting, parsing large JSON, or diffing lists. Its pool has as many threads as CPU cores, with a minimum of 2.
- `Dispatchers.IO`: blocking I/O like files, blocking network calls or legacy JDBC. It allows up to 64 threads or the number of cores, whichever is larger, because these threads mostly wait.
- `Dispatchers.Unconfined`: starts in the caller's thread and resumes on whatever thread resumed it. Not for app code.

`IO` and `Default` share the same threads under the hood. Switching between them with `withContext` often needs no real thread switch.

### limitedParallelism

`limitedParallelism(n)` makes a view of a dispatcher that runs at most `n` tasks at once.

```kotlin
// At most 1 at a time: a serial queue, good for confining state
private val dbDispatcher = Dispatchers.IO.limitedParallelism(1)

// Separate budget for a slow legacy SDK, so it cannot starve other IO work
private val legacySdk = Dispatchers.IO.limitedParallelism(4)
```

> **Note:** `Dispatchers.IO.limitedParallelism(n)` is elastic: its threads come on top of the 64-thread `IO` limit. `Dispatchers.Default.limitedParallelism(n)` never grows beyond `Default`'s own size.

### Main-safety

Google's rule: a suspend function should be safe to call from the main thread. The function itself does `withContext(Dispatchers.IO)`. The caller should not have to know.

```kotlin
class ArticleRepository(
    private val io: CoroutineDispatcher = Dispatchers.IO
) {
    suspend fun load(id: String): Article = withContext(io) {
        parse(file(id).readText()) // blocking work, off the main thread
    }
}
```

Room and Retrofit suspend functions are already main-safe. Wrapping them in `withContext(Dispatchers.IO)` again is harmless but useless.

> **Tip:** Inject dispatchers through the constructor, as above, instead of hardcoding `Dispatchers.IO`. In tests you pass a test dispatcher and everything runs on virtual time.

> **Pitfall:** Running a heavy CPU loop on `Dispatchers.IO` works, but it can create many threads that all compete for the CPU. Use `Default` for CPU work.

:::check
Q: What is `Dispatchers.IO + CoroutineName("a") + Dispatchers.Default + CoroutineName("b")`?
A: A context with `Dispatchers.Default` and `CoroutineName("b")`. For each key, the rightmost element wins.
Q: You must parse a 5 MB JSON string inside a ViewModel. Which dispatcher, and who should switch to it?
A: `Dispatchers.Default`, because parsing is CPU work. The repository or parser function should switch with `withContext`, so callers can safely call it from the main thread.
Q: Interview: What is the difference between `Dispatchers.IO` and `Dispatchers.Default`?
A: `Default` is for CPU-bound work and has about one thread per core. `IO` is for blocking I/O and allows many more threads (64 by default) because they mostly wait. They share one thread pool, so switching between them is cheap.
:::

## Structured concurrency

How scopes and the `Job` tree make sure no coroutine leaks and no error gets lost.

:::tldr
- Every coroutine runs in a scope, and its `Job` is a child of the scope's `Job`, forming a tree.
- Parents wait for children, cancellation flows down, and failures flow up.
- Passing your own `Job` to a builder, or using `GlobalScope`, breaks the tree.
:::

### The Job tree

Every coroutine lives inside a `CoroutineScope`. A scope is just a holder for a `CoroutineContext` that contains a `Job`. Each new coroutine's `Job` becomes a child of the scope's `Job`. This builds a tree.

```text
viewModelScope (SupervisorJob)
 ├── launch { loadFeed() }
 │     ├── async { api.posts() }
 │     └── async { api.stories() }
 └── launch { observeSettings() }
```

### The rules

- A parent does not complete until all its children complete.
- Cancelling a parent cancels all its children.
- If a child fails with a real exception (not cancellation), it cancels its parent. The parent then cancels the other children. A supervisor parent is the exception: it ignores child failures.
- When the scope ends, for example when a ViewModel is cleared, everything inside is cancelled.

The result: no leaked work, and no lost errors. You can reason about lifetimes by looking at the code's nesting.

### Parents wait for children

```kotlin
suspend fun main() {
    coroutineScope {
        launch {
            delay(100)
            println("child done")
        }
        println("body done")
    }
    println("scope done")
}
// body done
// child done
// scope done
```

The body of `coroutineScope` finished first, but the scope only returned after its child. That is the "Completing" state in the table below.

### Job states

| State | isActive | isCompleted | isCancelled |
|---|---|---|---|
| New (lazy start) | false | false | false |
| Active | true | false | false |
| Completing | true | false | false |
| Cancelling | false | false | true |
| Cancelled | false | true | true |
| Completed | false | true | false |

- **Completing** means the body finished but it is waiting for children.
- **Cancelling** means cancel was requested, and it is running `finally` blocks and waiting for children to stop.
- `job.join()` suspends until the job is completed or cancelled. `job.cancelAndJoin()` does both.

### Creating your own scope

Sometimes a class needs its own scope, for example a repository that keeps a socket open.

```kotlin
class SocketClient(dispatcher: CoroutineDispatcher) {
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)

    fun connect() = scope.launch { /* read loop */ }

    fun close() = scope.cancel() // cancels every child
}
```

Whoever creates a scope owns it and must cancel it. The `SupervisorJob` keeps one failing child from killing the whole client.

### How the tree breaks

- `launch(Job())` or `launch(SupervisorJob())`: the new `Job` becomes the parent. The coroutine is no longer a child of the scope, so cancelling the scope does not reach it.
- `GlobalScope.launch`: there is no parent at all. The work runs until it ends or the process dies. `GlobalScope` is marked `@DelicateCoroutinesApi` for this reason.
- `withContext(NonCancellable)` on normal work: it ignores cancellation on purpose. Keep it for cleanup only.

> **Interview:** "What is structured concurrency?" Every coroutine has a parent scope. Parents wait for children, cancellation flows down, and failures flow up. So when a scope like `viewModelScope` ends, nothing keeps running and no error is silently lost.

:::deeper Job vs SupervisorJob in one picture
```text
Job parent:            SupervisorJob parent:
  child A fails          child A fails
  -> parent cancelled    -> parent unaffected
  -> child B cancelled   -> child B keeps running
```

Both behave the same in the other direction: cancelling the parent cancels all children. The difference is only about a child's failure going up.
:::

:::check
Q: Predict the order of output: `coroutineScope { launch { delay(50); print("1") }; print("2") }; print("3")`.
A: `2`, then `1`, then `3`. The body prints `2` first, the scope waits for its child to print `1`, and only then does the code after the scope print `3`.
Q: `scope.launch(Job()) { work() }`, then `scope.cancel()`. Does `work()` stop?
A: No. The passed `Job()` became the parent of the coroutine, so it is not a child of the scope. Cancelling the scope does not reach it.
Q: Interview: What happens to its siblings when a child of a regular `Job` fails?
A: The failure cancels the parent, and the parent cancels all its other children. The exception then keeps going up the tree. Under a `SupervisorJob` or `supervisorScope`, the siblings keep running.
:::

## Cancellation

How cancellation really stops a coroutine, why it needs your cooperation, and how to clean up safely.

:::tldr
- Cancellation is cooperative: `cancel()` only sets a flag, and suspend functions check it and throw `CancellationException`.
- CPU loops must check with `isActive`, `ensureActive()` or `yield()`.
- Never swallow `CancellationException`; put suspend cleanup in `withContext(NonCancellable)`.
:::

### Cancellation is cooperative

`job.cancel()` does not kill a thread. It moves the `Job` to the cancelling state. The code must notice.

All suspend functions in `kotlinx.coroutines` notice. `delay`, `withContext`, `yield`, `await`, `join`, and channel and flow operations check for cancellation and throw `CancellationException`.

A tight CPU loop with no suspension points will **not** stop:

```kotlin
val job = launch(Dispatchers.Default) {
    var i = 0L
    while (i < 5_000_000_000) { i++ } // never checks
}
job.cancelAndJoin() // waits for the whole loop to finish
```

### Three ways to cooperate

```kotlin
while (isActive) { step() }   // check a flag, exit cleanly

for (item in bigList) {
    ensureActive()            // throws CancellationException if cancelled
    process(item)
}

for (item in bigList) {
    yield()                   // checks cancellation AND lets others run
    process(item)
}
```

Use `ensureActive()` in most loops. Use `yield()` when you also want to give other coroutines on the same dispatcher a turn.

> **Note:** Blocking calls like `Thread.sleep` or a blocking socket read do not notice cancellation. Prefer suspend APIs, or use `runInterruptible` to turn cancellation into a thread interrupt.

### Cleanup with try/finally

Cancellation throws `CancellationException` at the suspension point. So `finally` blocks run, and `use { }` closes resources.

```kotlin
launch {
    try {
        repeat(1000) { delay(100) }
    } finally {
        // We are cancelled. A normal suspend call here would throw again.
        withContext(NonCancellable) {
            repository.saveProgress() // must finish
        }
    }
}
```

> **Pitfall:** In a cancelled coroutine, any suspend call in `finally` throws `CancellationException` right away. Wrap must-run suspend cleanup in `withContext(NonCancellable)`. Never pass `NonCancellable` to `launch` or `async`.

### CancellationException rules

- It is the normal signal for cancellation, not a failure.
- It does not cancel the parent.
- It is not reported to `CoroutineExceptionHandler`.
- **Never swallow it.** If you catch `Exception` or `Throwable`, rethrow it.

```kotlin
try {
    api.call()
} catch (e: CancellationException) {
    throw e                 // keep cancellation working
} catch (e: Exception) {
    showError(e)
}
```

> **Pitfall:** `runCatching { suspendCall() }` also catches `CancellationException`. The coroutine keeps running after it was cancelled. Rethrow it, or write a small helper that excludes it.

Swallowing it is dangerous because the code after the catch keeps going. It may update a screen that no longer exists or write stale data.

### Timeouts

```kotlin
val data = withTimeoutOrNull(3_000) { api.slowCall() } // null on timeout

try {
    withTimeout(3_000) { api.slowCall() }
} catch (e: TimeoutCancellationException) {
    showTimeout()
}
```

`TimeoutCancellationException` is a subclass of `CancellationException`. If it escapes a `launch`, it is treated as a normal cancellation, not a crash, so the failure is easy to miss. Prefer `withTimeoutOrNull`, or catch the exception close to the call.

> **Interview:** "How do you cancel a long computation?" Cancel its `Job` and make the computation cooperative: call `ensureActive()` or `yield()` in the loop, or check `isActive`. Clean up in `finally`.

:::deeper Who throws, and when
- `cancel()` itself throws nothing. It only marks the `Job`.
- The next cancellable suspend call in that coroutine throws `CancellationException`.
- If the coroutine never reaches one, it runs to the end, and only then is the `Job` marked cancelled.
- Children are cancelled too, and the parent waits for them to finish their `finally` blocks.
- `job.cancel(CancellationException("reason"))` lets you attach a message, which helps in logs.
:::

:::check
Q: Spot the bug: `launch { while (true) { val x = heavyMath(); results += x } }` never stops after `cancel()`. How do you fix it?
A: The loop never suspends, so it never checks for cancellation. Use `while (isActive)` or call `ensureActive()` inside the loop.
Q: Code catches `Exception` around `repository.load()` and logs it. The screen closes mid-call. What goes wrong?
A: The `CancellationException` is caught and logged as an error, and the coroutine keeps running code after the catch. Rethrow `CancellationException` before the general catch.
Q: Interview: How does cancellation work in coroutines?
A: It is cooperative. `cancel()` marks the `Job` as cancelling, and library suspend functions check that and throw `CancellationException`; CPU code must check `isActive`, call `ensureActive()` or `yield()`. Cleanup goes in `finally`, and suspend cleanup needs `withContext(NonCancellable)`.
:::

## Exception handling

How exceptions travel through `launch`, `async` and scopes, and where `CoroutineExceptionHandler` actually works.

:::tldr
- In `launch`, an uncaught exception goes up to the parent at once; in `async`, it is thrown at `await()` and also fails the parent.
- `CoroutineExceptionHandler` only works on root coroutines and direct children of a supervisor, and only for logging.
- Catch close to the failing code; wrap a whole `coroutineScope` to contain a failing `async`.
:::

### launch vs async

- `launch`: an uncaught exception propagates **up** to the parent right away. If it reaches a root coroutine, it goes to the `CoroutineExceptionHandler`. Without one, it goes to the thread's uncaught exception handler. On Android, that crashes the app.
- `async`: the exception is stored in the `Deferred` and thrown at `await()`. But if the `async` is a child of a regular `Job`, it **also** fails the parent immediately. A `try/catch` around only `await()` does not stop that.

```kotlin
// Looks safe, but the parent scope still fails
scope.launch {
    val d = async { error("boom") }
    try { d.await() } catch (e: Exception) { /* caught, too late */ }
}

// Correct: contain the failure in coroutineScope, catch around it
scope.launch {
    try {
        coroutineScope {
            val d = async { error("boom") }
            d.await()
        }
    } catch (e: Exception) { showError(e) }
}
```

`coroutineScope` rethrows the child's exception to its caller instead of passing it further up. So a normal `try/catch` works around it.

### Job vs SupervisorJob

| Event | Job | SupervisorJob |
|---|---|---|
| A child fails | Parent and all siblings cancelled | Only that child fails |
| Parent cancelled | Children cancelled | Children cancelled |
| Typical use | Tasks that must succeed together | Independent tasks, UI scopes |

### CoroutineExceptionHandler

The handler is called only for **uncaught** exceptions in **root** coroutines, or in direct children of a supervisor.

- It works on a `launch` that is started directly in a scope.
- It does nothing on a nested child of a regular `Job`. The child passes the exception to its parent instead.
- It does nothing for `async`. The exception goes into the `Deferred`.
- It cannot recover the coroutine. When it runs, the coroutine has already finished. Use it to log and show a generic error.

```kotlin
val handler = CoroutineExceptionHandler { _, e -> log(e) }

scope.launch(handler) { error("A") }      // handler called

scope.launch {
    launch(handler) { error("B") }        // NOT called: goes to the parent
}

scope.launch {
    supervisorScope {
        launch(handler) { error("C") }    // called: supervisor child acts as a root
    }
}
```

> **Pitfall:** `scope.launch(SupervisorJob()) { launch { fail() }; launch { other() } }` does not give supervisor behaviour to the inner children. The `SupervisorJob` is the parent of the outer coroutine only. It is also detached from the scope, so cancelling the scope no longer reaches this work. Use `supervisorScope { }` instead.

### Where to put try/catch

Put `try/catch` inside the coroutine, around the code that can fail. Turn errors into state the UI can show.

```kotlin
fun refresh() = viewModelScope.launch {
    _state.update { it.copy(loading = true) }
    try {
        val items = repo.load()
        _state.update { it.copy(loading = false, items = items) }
    } catch (e: IOException) {
        _state.update { it.copy(loading = false, error = e.message) }
    }
}
```

Catching a specific type like `IOException` also avoids the `CancellationException` trap.

> **Interview:** "Where do you handle coroutine errors?" With `try/catch` close to the failing code, mapped to UI state. A `CoroutineExceptionHandler` on the scope is the last resort for logging, not for business logic.

### Multiple failures

If several children fail, the first exception wins and is thrown. The others are attached to it as **suppressed** exceptions.

:::deeper supervisorScope with async
In a `supervisorScope`, a failing `async` does not cancel its siblings or the scope. Its exception only appears when you call `await()`.

```kotlin
suspend fun loadAll() = supervisorScope {
    val weather = async { api.weather() }
    val news = async { api.news() }
    val w = runCatching { weather.await() }.getOrNull()
    val n = runCatching { news.await() }.getOrNull()
    Dashboard(w, n)
}
```

If the outer coroutine is cancelled, `await()` throws `CancellationException` and `runCatching` would catch it. In real code, rethrow it, for example with a helper that skips `CancellationException`.
:::

:::check
Q: A `CoroutineExceptionHandler` is passed to a `launch` nested inside another `launch`. The inner one throws. Is the handler called?
A: No. A nested child of a regular `Job` passes its exception to its parent. Only the root coroutine's handler, or the scope's, is used.
Q: Inside `scope.launch`, you write `val d = async { fail() }` and wrap only `d.await()` in `try/catch`. Why does the scope still see the failure?
A: The failing `async` child cancels its parent as soon as it fails, before `await` is even reached. Wrap a `coroutineScope { }` in the `try/catch` to contain it.
Q: Interview: Explain `launch` vs `async` for exception handling.
A: `launch` propagates an uncaught exception up to its parent immediately and, at the root, to the handler. `async` stores it in the `Deferred` and throws at `await()`, but as a child of a regular `Job` it also fails its parent right away.
:::

## Android scopes

The scopes Android gives you, how to collect flows safely in the UI, and what to use instead of `GlobalScope`.

:::tldr
- `viewModelScope` and `lifecycleScope` both use `SupervisorJob() + Dispatchers.Main.immediate`.
- Collect flows in the UI with `repeatOnLifecycle(STARTED)` or `collectAsStateWithLifecycle()`.
- For work that outlives a screen, inject an application scope; for work that must survive process death, use WorkManager.
:::

### viewModelScope

- Tied to the ViewModel. It is cancelled when the ViewModel is cleared.
- Uses `SupervisorJob() + Dispatchers.Main.immediate`.
- Survives configuration changes, because the ViewModel does.

```kotlin
class FeedViewModel(private val repo: FeedRepository) : ViewModel() {
    private val _state = MutableStateFlow(FeedState())
    val state: StateFlow<FeedState> = _state.asStateFlow()

    fun refresh() {
        viewModelScope.launch {
            _state.update { it.copy(loading = true) }
            val items = repo.load() // main-safe suspend fun
            _state.update { it.copy(loading = false, items = items) }
        }
    }
}
```

The `SupervisorJob` means one failed `launch` does not cancel the others. But an uncaught exception still crashes the app, so catch errors inside.

### lifecycleScope

- Tied to an Activity or Fragment `Lifecycle`. Cancelled when it reaches `DESTROYED`.
- Also `SupervisorJob() + Dispatchers.Main.immediate`.
- In a Fragment, use `viewLifecycleOwner.lifecycleScope` for anything that touches views. A Fragment can outlive its view, for example on the back stack.

### repeatOnLifecycle

`repeatOnLifecycle(state)` runs a block when the lifecycle reaches `state`. It **cancels** the block when the lifecycle drops below it. It starts the block again the next time the state is reached.

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

Each flow needs its own `launch`, because `collect` suspends until the flow ends. A second `collect` placed after the first would never run.

For a single flow, `flow.flowWithLifecycle(lifecycle)` does the same thing.

> **Pitfall:** `lifecycleScope.launch { flow.collect { } }` keeps collecting while the app is in the background. Location or sensor flows keep running and drain the battery. Use `repeatOnLifecycle` or `flowWithLifecycle`.

> **Note:** The old `launchWhenStarted` family is deprecated. It only **paused** the coroutine, so upstream producers kept running. `repeatOnLifecycle` cancels and restarts instead.

### Compose

In Compose, use `collectAsStateWithLifecycle()` from `androidx.lifecycle:lifecycle-runtime-compose`. It stops collecting when the lifecycle drops below `STARTED`.

```kotlin
@Composable
fun FeedRoute(viewModel: FeedViewModel = viewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    FeedScreen(state)
}
```

Plain `collectAsState()` keeps collecting while the app is in the background. On Android, prefer the lifecycle version.

### Why not GlobalScope

- No parent, so no structured concurrency. Work leaks when the screen goes away.
- Nothing cancels it automatically, and it is hard to replace in tests.
- Its uncaught exceptions go straight to the thread's uncaught handler.

For work that must outlive a screen, like finishing an upload the user started, inject an **application scope** from your DI graph:

```kotlin
@Provides @Singleton
fun appScope(): CoroutineScope =
    CoroutineScope(SupervisorJob() + Dispatchers.Default)
```

For work that must survive process death or run later, use WorkManager with a `CoroutineWorker`.

> **Interview:** "What is `Dispatchers.Main.immediate` and why do the Android scopes use it?" If you are already on the main thread, it runs the code at once instead of posting it to the Looper. Updates happen in the same frame and you skip a needless dispatch.

:::check
Q: Inside `repeatOnLifecycle(STARTED)` you write `viewModel.state.collect { }` and then `viewModel.events.collect { }` on the next line. What happens?
A: The events flow is never collected. `collect` on a `StateFlow` never returns, so the second line is never reached; wrap each in its own `launch`.
Q: A Fragment uses `lifecycleScope` (not `viewLifecycleOwner.lifecycleScope`) to collect state and update a `TextView`. When can this crash?
A: When the Fragment is on the back stack, its view is destroyed but the Fragment lifecycle is not. The collector keeps running and touches a dead view or binding.
Q: Interview: Why should you not use `GlobalScope` in an Android app?
A: It has no parent, so work is never cancelled with the screen and can leak or update dead UI; it is also hard to test. Use `viewModelScope`, an injected application scope, or WorkManager depending on how long the work must live.
:::

## Thread safety

How to share mutable state between coroutines without races, using confinement, atomics, `Mutex` and `Semaphore`.

:::tldr
- Coroutines on `Default` or `IO` run in parallel, so plain `count++` on shared state is a race.
- Prefer no shared state, then atomics or `MutableStateFlow.update`, then confinement, then `Mutex`.
- `Mutex` is a suspending lock and is not reentrant; never hold `synchronized` across a suspension.
:::

### The race

```kotlin
var counter = 0

suspend fun massiveRun() = withContext(Dispatchers.Default) {
    repeat(1_000) {
        launch { repeat(1_000) { counter++ } }
    }
}
// Expected 1_000_000. Usually prints less.
```

`counter++` is read, add, write. Two threads can read the same value, and one increment is lost. `@Volatile` does not help, because it makes reads and writes visible but not the whole increment atomic.

### Options, simplest first

1. **Avoid shared state.** Have each coroutine return a value, then combine the results.
2. **Atomics.** `AtomicInteger`, `AtomicReference`, or `MutableStateFlow.update { }`, which is an atomic compare-and-set loop.
3. **Confinement.** Do all access to the state on one thread, for example `Dispatchers.Default.limitedParallelism(1)`.
4. **Mutex.** A lock for critical sections, especially sections that suspend.

```kotlin
private val _state = MutableStateFlow(Cart())

fun add(item: Item) {
    _state.update { cart -> cart.copy(items = cart.items + item) }
}
```

> **Pitfall:** `update { }` may run its lambda more than once if another thread changed the value in between. Keep the lambda pure: no network calls, no logging that must happen once.

### Confinement

```kotlin
private val serial = Dispatchers.Default.limitedParallelism(1)
private var cache = mutableMapOf<String, User>()

suspend fun put(id: String, user: User) = withContext(serial) {
    cache[id] = user // only one coroutine at a time runs here
}
```

All reads and writes must go through `serial`. One slip on another dispatcher brings the race back.

### Mutex

A `Mutex` is a suspending lock. A coroutine that waits for it suspends instead of blocking a thread.

```kotlin
private val mutex = Mutex()
private var cachedToken: String? = null

suspend fun token(): String = mutex.withLock {
    cachedToken ?: api.refreshToken().also { cachedToken = it }
}
```

If ten coroutines call `token()` at once with no cached token, only the first one calls the network. The others wait, then find the cached value.

> **Pitfall:** `Mutex` is **not reentrant**. Calling `withLock` on the same mutex again from inside the lock deadlocks.

> **Pitfall:** Do not use `synchronized` around code that suspends. The lock belongs to a thread, and the coroutine may resume on another thread. The compiler reports an error for a suspend call inside a `synchronized` block for this reason.

`synchronized` is still fine for short, non-suspending sections. It just must not contain a suspension point.

### Semaphore

A `Semaphore` limits how many coroutines can be inside a section at once.

```kotlin
private val semaphore = Semaphore(permits = 3)

suspend fun download(url: String) = semaphore.withPermit {
    http.get(url) // at most 3 downloads at a time
}
```

`limitedParallelism(3)` limits threads running at once. A `Semaphore` limits coroutines inside a section, even while they are suspended in it. For "at most 3 network calls in flight", the `Semaphore` is the right tool.

> **Interview:** "Why not `synchronized` in coroutines?" It blocks a thread while waiting, and it is tied to the thread that took the lock. A coroutine can suspend and resume elsewhere, so use `Mutex`, which suspends and is not tied to a thread.

:::check
Q: You make the shared `counter` `@Volatile` and still lose increments. Why?
A: `@Volatile` only makes each read and write visible to other threads. `counter++` is still read, add, write, so two threads can interleave; use `AtomicInteger`, a `Mutex`, or confinement.
Q: Spot the bug: `mutex.withLock { if (expired()) refresh() }`, where `refresh()` also calls `mutex.withLock { }`.
A: It deadlocks. `Mutex` is not reentrant, so the inner `withLock` waits forever for a lock the same coroutine already holds.
Q: Interview: Ten coroutines call `getToken()` at the same time when the token is expired. How do you make sure only one refresh happens?
A: Guard the check-and-refresh with a `Mutex` and `withLock`: the first caller refreshes and stores the token, the rest suspend and then read the cached value. `synchronized` is wrong because the refresh suspends.
:::

## Channels

How coroutines pass values to each other with channels, and when to use a channel instead of a flow.

:::tldr
- A `Channel` is a suspending queue: `send` and `receive` suspend instead of blocking, and each value goes to one receiver.
- Capacity sets behaviour: rendezvous (default), buffered (64), unlimited, or conflated.
- In app code, prefer Flow; channels mostly appear inside `channelFlow`, `callbackFlow`, and for one-off events.
:::

### What a channel is

A `Channel` is like a `BlockingQueue`, but `send` and `receive` suspend instead of blocking. A channel is **hot**: it exists on its own, whether or not anyone is receiving. Each value is delivered to exactly **one** receiver.

```kotlin
val channel = Channel<Int>(capacity = Channel.BUFFERED)

launch {
    for (i in 1..5) channel.send(i)
    channel.close() // no more values
}

for (value in channel) println(value) // loop ends after close
```

### Capacity types

| Type | Capacity | What send does |
|---|---|---|
| `RENDEZVOUS` | 0 (the default) | Suspends until a receiver takes the value |
| `BUFFERED` | 64 by default | Suspends only when the buffer is full |
| `UNLIMITED` | No limit | Never suspends, may run out of memory |
| `CONFLATED` | 1, keeps the latest | Never suspends, overwrites the old value |

You can also pass a number and `onBufferOverflow = BufferOverflow.DROP_OLDEST` or `DROP_LATEST`. Then `send` never suspends and drops values instead.

### Non-suspending calls

- `trySend(x)` returns a result instead of suspending. It fails if the buffer is full or the channel is closed.
- `tryReceive()` returns a value or a failure if the channel is empty.

These are useful from regular code, like a listener callback that cannot suspend.

### Closing vs cancelling

- `close()` says "no more values". Values already in the buffer can still be received. Then the receive loop ends.
- `cancel()` on the receiving side drops buffered values and closes the channel for both sides.
- `send` on a closed channel throws `ClosedSendChannelException`.

> **Pitfall:** If you never close a channel, a `for (x in channel)` loop waits forever. Close it when the producer is done.

### produce

`produce` is a builder that starts a coroutine and returns a `ReceiveChannel`. It closes the channel when the block ends, even on failure.

```kotlin
fun CoroutineScope.numbers(): ReceiveChannel<Int> = produce {
    var x = 1
    while (true) send(x++)
}
```

`produce` is still marked `@ExperimentalCoroutinesApi`.

### Fan-out and fan-in

- **Fan-out:** many coroutines receive from one channel. Each item goes to one worker, so work is split.
- **Fan-in:** many coroutines send into one channel.

```kotlin
val tasks = Channel<Task>()
repeat(4) { id ->
    launch { for (t in tasks) process(id, t) } // 4 workers share the work
}

val results = Channel<Data>()
launch { results.send(fromCache()) }   // two producers,
launch { results.send(fromNetwork()) } // one channel
```

### Channel vs Flow

| Question | Channel | Flow |
|---|---|---|
| Hot or cold | Hot | Cold (except StateFlow and SharedFlow) |
| Who gets a value | One receiver | Every collector |
| Runs without a consumer | Yes, until the buffer is full | No, starts at collect |
| Must be closed | Yes | No, ends on its own |

> **Note:** In app code, prefer Flow. Channels are a low-level primitive. They mostly show up inside `channelFlow` and `callbackFlow`, in worker pools, and as a buffer for one-off UI events with `receiveAsFlow()`.

> **Interview:** "Channel or SharedFlow for broadcasting to many listeners?" SharedFlow. A channel gives each value to only one receiver, so two collectors would split the values between them.

:::check
Q: A rendezvous channel has no receiver yet. The producer calls `send(1)`. What happens?
A: `send` suspends until some coroutine calls `receive`. A rendezvous channel has no buffer, so the value is handed over directly.
Q: Two collectors call `receiveAsFlow().collect { }` on the same channel, which gets values 1 to 4. What does each see?
A: They split the values; each value goes to only one of them, for example 1 and 3 to one and 2 and 4 to the other. Channels are fan-out, not broadcast.
Q: Interview: When would you use a channel instead of a flow?
A: When values must be delivered once to one consumer, like a work queue or a buffer for one-off events, or to pass values between coroutines that run concurrently. For streams that many consumers observe, use Flow, SharedFlow or StateFlow.
:::

## Flow fundamentals

What a cold Flow is, the builders to create one, and the terminal operators that run it.

:::tldr
- A `Flow` is cold: nothing runs until a terminal operator like `collect`, and each collector gets a fresh run.
- Use `flow { }` for most cases, `channelFlow` for concurrent emits, and `callbackFlow` to wrap listeners.
- `callbackFlow` must end with `awaitClose { }`, which unregisters the listener.
:::

### Cold streams

A `Flow<T>` is an asynchronous stream of values. It is **cold**: the code inside does not run until someone calls a terminal operator. Each collector gets its own, fresh execution.

```kotlin
val numbers: Flow<Int> = flow {
    println("started")
    for (i in 1..3) {
        delay(100)
        emit(i)
    }
}

numbers.collect { println(it) } // started, 1, 2, 3
numbers.collect { println(it) } // started, 1, 2, 3 again
```

By default, the producer and the collector run in the same coroutine, one step at a time. `emit` calls the collector's lambda and waits for it to return. This is natural backpressure.

### Builders

- `flow { emit(x) }`: the general builder. Emits must happen in the same coroutine, one at a time.
- `flowOf(1, 2, 3)`: a fixed set of values.
- `listOf(1, 2).asFlow()`: from collections, sequences and ranges.
- `channelFlow { send(x) }`: can emit from several coroutines at once.
- `callbackFlow { trySend(x) }`: wraps a listener or callback API.

### channelFlow

`flow { }` forbids emitting from another coroutine. `channelFlow` puts a channel behind the scenes, so concurrent sends are safe.

```kotlin
fun loadAll(ids: List<String>): Flow<Item> = channelFlow {
    ids.forEach { id ->
        launch { send(api.load(id)) } // concurrent sends: allowed here
    }
}
```

The flow completes when all launched children finish.

### callbackFlow

`callbackFlow` turns a listener that fires many times into a flow.

```kotlin
fun LocationClient.updates(): Flow<Location> = callbackFlow {
    val listener = LocationListener { loc -> trySend(loc) }
    requestUpdates(listener)
    awaitClose { removeUpdates(listener) } // runs when the collector stops
}
```

- Use `trySend` in the listener, because the listener is not a suspend function.
- `awaitClose` suspends until the flow is closed or the collector is cancelled. Then it runs the cleanup.
- To end the flow from inside, call `close()` or `close(exception)`.

> **Pitfall:** Forgetting `awaitClose` makes `callbackFlow` throw an `IllegalStateException` when the block finishes. Without it you would also never unregister the listener.

The default buffer is 64 values. If the listener is faster than the collector and the buffer is full, `trySend` fails and the value is lost. Add `.buffer(Channel.UNLIMITED)` or `.conflate()` to choose the behaviour on purpose.

### Terminal operators

A terminal operator is a suspend function that starts the collection.

| Operator | What it does |
|---|---|
| `collect` | Runs the flow and handles each value |
| `first`, `firstOrNull` | Takes one value, then cancels the flow |
| `single` | Expects exactly one value |
| `toList`, `toSet` | Collects everything into a collection |
| `reduce`, `fold` | Aggregates values |
| `count` | Counts values |
| `launchIn(scope)` | Shortcut for `scope.launch { collect() }` |

```kotlin
flow.onEach { render(it) }
    .launchIn(viewModelScope) // returns a Job, does not suspend
```

> **Pitfall:** `collect` suspends until the flow ends. On an endless flow, code after `collect` in the same coroutine never runs.

### Intermediate operators are lazy

Operators like `map` and `filter` do not run anything. They return a new flow that wraps the old one. Work happens only when a terminal operator collects the final flow.

> **Interview:** "Cold vs hot flow?" A cold flow like `flow { }` runs its producer once per collector, starting at `collect`. A hot flow like `StateFlow` or `SharedFlow` exists without collectors and shares its values with all of them.

:::check
Q: `val f = flow { println("A"); emit(1) }`. You call `f.map { it * 2 }` but never collect. What prints?
A: Nothing. Flows are cold and `map` is lazy; the body runs only when a terminal operator like `collect` is called.
Q: Inside `flow { }` you write `launch { emit(1) }` from a `coroutineScope`. What happens, and what should you use?
A: It fails with an `IllegalStateException` about flow invariant violation, because `flow { }` does not allow emitting from another coroutine. Use `channelFlow` with `send`.
Q: Interview: How do you turn a listener-based API into a Flow?
A: Use `callbackFlow`: register the listener, call `trySend` from it, and end with `awaitClose { unregister() }`. The cleanup runs when the collector is cancelled, so the listener never leaks.
:::

## Flow operators

The operators you use every day: transforming, flattening, combining and rate limiting.

:::tldr
- `map`, `filter` and `transform` change values; `onEach` adds side effects.
- `flatMapLatest` cancels the old inner flow on a new value, ideal for search and selection.
- `combine` emits the latest of all sources on any change; `zip` pairs values one to one.
:::

### Transforming

```kotlin
flow.map { it * 2 }
    .filter { it > 10 }
    .mapNotNull { lookup(it) }
    .transform { value ->       // emit zero, one or many per input
        emit("start $value")
        emit(heavyWork(value))
    }
    .take(5)                    // cancels upstream after 5 values
```

`onEach { }` runs a side effect and passes the value through. It is good for logging.

`scan` emits every running total, for example `scan(0) { acc, x -> acc + x }`. `runningReduce` is the same without a start value.

### Flattening

When each value maps to a new flow, you need a flattening operator.

| Operator | Behaviour | Use case |
|---|---|---|
| `flatMapConcat` | One inner flow at a time, in order | Ordered steps |
| `flatMapMerge` | Many at once, 16 by default | Parallel downloads |
| `flatMapLatest` | Cancels the old inner flow on a new value | Search, selected item |

```kotlin
val results: Flow<List<Item>> = queryFlow
    .debounce(300)
    .distinctUntilChanged()
    .flatMapLatest { query ->
        if (query.isBlank()) flowOf(emptyList())
        else repository.search(query)
    }
```

When the user types a new query, the search for the old query is cancelled. Results from an old query can never overwrite newer ones.

`mapLatest { }` is the same idea for a single suspend call per value instead of a flow.

> **Note:** `flatMapLatest`, `flatMapMerge`, `flatMapConcat` and `mapLatest` need `@OptIn(ExperimentalCoroutinesApi::class)`. `debounce` and `sample` need `@OptIn(FlowPreview::class)`. They are widely used and stable in practice.

### combine vs zip

- `combine(a, b)` emits whenever **any** source emits, using the latest value of each. It waits until every source has emitted at least once.
- `zip(a, b)` pairs values one by one: the first of `a` with the first of `b`, and so on. It stops when either flow ends.

```kotlin
val uiState = combine(userFlow, settingsFlow, cartFlow) { user, settings, cart ->
    UiState(user, settings, cart)
}

val pairs = flowOf(1, 2, 3).zip(flowOf("a", "b")) { n, s -> "$n$s" } // 1a, 2b
```

`merge(a, b)` is a third option. It emits every value from every source as it arrives, with no pairing. The sources must have the same type.

> **Pitfall:** If one source of `combine` never emits, `combine` never emits either. A database flow that has not loaded yet blocks the whole UI state. Give such sources a start value with `onStart { emit(default) }`.

### Rate limiting and dedupe

- `debounce(300)`: emits a value only if no newer value arrives within 300 ms. The classic search box operator.
- `sample(1000)`: emits the latest value once per period. Good for fast sensor data.
- `distinctUntilChanged()`: skips a value equal to the one before. `StateFlow` already does this.

### Lifecycle hooks

```kotlin
repository.feed()
    .map<List<Post>, FeedState> { FeedState.Data(it) }
    .onStart { emit(FeedState.Loading) }   // before the first upstream value
    .catch { emit(FeedState.Error(it)) }   // upstream errors only
    .onCompletion { cause -> log("done, cause=$cause") }
```

- `onStart` runs before collection starts and can emit values.
- `onCompletion` runs at the end. `cause` is `null` on success, or the exception, including `CancellationException`. It sees the error but does not catch it.
- `onEmpty` emits a fallback if the flow completed with no values.

> **Interview:** "Which operator builds UI state from several sources?" Almost always `combine`, because the UI needs the latest value of each source on every change. `zip` is for strict one-to-one pairing, which UI state rarely needs.

:::check
Q: `flowOf(1, 2, 3).zip(flowOf("a", "b"))` vs `combine` of the same two flows (no delays). How many values does `zip` emit?
A: Two: `1a` and `2b`. `zip` pairs one to one and stops when the shorter flow ends. `combine` would emit based on latest values, and the exact output depends on timing.
Q: A search screen uses `flatMapConcat` instead of `flatMapLatest`. The user types "ca" then "cat" quickly. What bug can the user see?
A: Results for "ca" are fully loaded and shown before the "cat" search even starts, so the screen is slower and briefly shows stale results. `flatMapLatest` cancels the "ca" search when "cat" arrives.
Q: Interview: Compare `flatMapConcat`, `flatMapMerge` and `flatMapLatest`.
A: `flatMapConcat` runs inner flows one after another in order. `flatMapMerge` runs them concurrently, up to a limit. `flatMapLatest` cancels the previous inner flow when a new value arrives, which suits search queries or a selected ID.
:::

## Backpressure and errors

How to handle a slow collector, where a flow runs and how `flowOn` changes that, and how errors travel through a flow.

:::tldr
- A slow collector slows the producer; `buffer`, `conflate` and `collectLatest` decouple them in different ways.
- A flow runs in the collector's context; use `flowOn` to move the upstream, never `withContext` around `emit`.
- `catch` handles upstream errors only, ends the flow, and must not be replaced by `try/catch` around `emit`.
:::

### Backpressure

By default, the producer and the collector run one step at a time in one coroutine. If `collect` is slow, `emit` waits. That is natural backpressure. Three ways to decouple them:

- `buffer()`: runs the producer in a separate coroutine with a buffer. Both run at the same time.
- `conflate()`: keeps only the latest value. A slow collector skips old ones.
- `collectLatest { }`: when a new value arrives, cancels the work for the old one.

```kotlin
// Producer: 100 ms per item. Collector: 300 ms per item.
flow.collect { slow(it) }            // about 400 ms per item
flow.buffer().collect { slow(it) }   // about 300 ms per item, overlapped
flow.conflate().collect { slow(it) } // skips stale items
flow.collectLatest { slow(it) }      // only the last item finishes
```

`buffer` also takes a capacity and an `onBufferOverflow` strategy, like a channel. `conflate()` is the same as `buffer(CONFLATED)`.

> **Tip:** For UI rendering, `conflate` or `collectLatest` usually fit, because only the newest state matters. For events that must all be handled, use `buffer`.

### Context preservation

A flow runs in the context of the **collector**. The `flow { }` block must not switch context itself. Calling `emit` from inside `withContext` throws an `IllegalStateException` ("Flow invariant is violated").

### flowOn

`flowOn` changes the context of everything **upstream** of it. Downstream operators keep the collector's context.

```kotlin
repository.items()             // runs on IO
    .map { parse(it) }         // runs on IO
    .flowOn(Dispatchers.IO)
    .map { toUiModel(it) }     // runs on the collector's dispatcher
    .collect { render(it) }    // Main
```

Several `flowOn` calls each affect only their own upstream section.

> **Under the hood:** `flowOn` runs the upstream in a new coroutine and connects it to the downstream with a channel. That is why `flowOn` with a new dispatcher also adds a buffer.

### Exception transparency

A flow must not hide exceptions from its downstream. The rules:

- Do not wrap `emit` in `try/catch` inside `flow { }`. An exception thrown by the collector comes out of `emit`. You would catch the collector's error and maybe emit again, which breaks the contract.
- Use the `catch` operator. It catches only exceptions from **upstream** of it, never from downstream or from `collect`.

```kotlin
flow { emit(1); throw IOException() }
    .catch { e -> emit(-1) }   // catches the IOException
    .collect { value ->
        check(value > 0)       // NOT caught by the catch above
    }
```

To also catch errors from your handling code, move it into `onEach` and put `catch` after it:

```kotlin
flow.onEach { value -> handle(value) }
    .catch { e -> showError(e) }
    .launchIn(scope)
```

> **Pitfall:** After `catch` runs, the original flow is **done**. `catch` cannot resume it. To keep a long-lived stream alive, catch inside the inner flow, for example inside `flatMapLatest`, or use `retry`.

### Retrying

```kotlin
api.stream()
    .retryWhen { cause, attempt ->
        if (cause is IOException && attempt < 3) {
            delay(1000L * (attempt + 1)) // simple backoff
            true
        } else false
    }
```

`retry(3) { it is IOException }` is the simpler form. Retrying re-collects the upstream from the start, because the flow is cold.

> **Interview:** "Where does a flow run?" In the collector's coroutine by default. `flowOn` changes only the operators above it, and `withContext` inside `flow { }` is not allowed.

:::check
Q: `flow.map { a(it) }.flowOn(Dispatchers.IO).map { b(it) }.collect { c(it) }` is collected on Main. Where do `a`, `b` and `c` run?
A: `a` runs on `IO`, because it is upstream of `flowOn`. `b` and `c` run on Main, the collector's context.
Q: Spot the bug: `flow { try { emit(load()) } catch (e: Exception) { emit(Error) } }`.
A: The `try` also wraps the collector's code that runs inside `emit`, so a collector exception is caught and the flow emits again, breaking exception transparency. Use `.catch { emit(Error) }` instead.
Q: Interview: What is exception transparency in Flow?
A: A flow must never catch exceptions that come from downstream, so you do not wrap `emit` in `try/catch`. The `catch` operator only handles upstream errors; to handle errors from processing, move it into `onEach` before `catch`.
:::

## StateFlow and SharedFlow

The hot flows that hold UI state and broadcast values, how to share a cold flow, and how to send one-off events.

:::tldr
- `StateFlow` always has a value, conflates, and skips equal values; update it with `update { }`.
- `SharedFlow` is configurable with `replay`, `extraBufferCapacity` and `onBufferOverflow`.
- Use `stateIn(scope, WhileSubscribed(5_000), initial)` in a `val` to turn a cold flow into UI state.
:::

### StateFlow

Regular flows are cold. `StateFlow` and `SharedFlow` are **hot**: they exist and hold or emit values whether anyone collects or not, and all collectors share them.

- Always has a value, so it needs an initial value.
- A new collector gets the current value right away.
- **Conflated**: a slow collector only sees the latest value.
- **Dedupe by equals**: setting a value equal to the current one emits nothing.

```kotlin
private val _state = MutableStateFlow(UiState())
val state: StateFlow<UiState> = _state.asStateFlow()

fun onNameChanged(name: String) {
    _state.update { it.copy(name = name) } // atomic read-modify-write
}
```

> **Pitfall:** `_state.value = _state.value.copy(...)` from several coroutines can lose updates. Use `update { }`.

> **Pitfall:** Mutating a list inside the state and setting the same instance again emits nothing, because it equals itself. Use immutable data and create new instances.

### SharedFlow

A hot stream you can configure. It needs no initial value.

```kotlin
val events = MutableSharedFlow<Event>(
    replay = 0,                               // values replayed to new subscribers
    extraBufferCapacity = 64,                 // extra room beyond replay
    onBufferOverflow = BufferOverflow.SUSPEND // or DROP_OLDEST, DROP_LATEST
)
```

- `replay`: how many past values a new collector receives.
- `extraBufferCapacity`: room for fast emitters, so `emit` does not suspend and `tryEmit` can succeed.
- With the defaults (no replay, no extra buffer), `tryEmit` fails while there are subscribers, and values emitted with no subscribers are dropped.

> **Under the hood:** `MutableStateFlow(initial)` behaves like `MutableSharedFlow(replay = 1, onBufferOverflow = DROP_OLDEST)` that got `initial` emitted, plus `distinctUntilChanged()`. StateFlow is a special, simpler SharedFlow.

### Compared with LiveData

| Feature | StateFlow | SharedFlow | LiveData |
|---|---|---|---|
| Initial value | Required | Not needed | Optional |
| Replay | Latest 1 | 0 to n | Latest 1 |
| Dedupe | Yes, by equals | No | No |
| Lifecycle aware | No, use repeatOnLifecycle | No | Yes |
| Operators | Full Flow API | Full Flow API | A few |
| Pure Kotlin and KMP | Yes | Yes | No |

### stateIn and shareIn

These turn a cold flow into a hot one that all collectors share.

```kotlin
val uiState: StateFlow<UiState> = combine(repo.user(), repo.settings()) { u, s ->
    UiState.Data(u, s)
}.stateIn(
    scope = viewModelScope,
    started = SharingStarted.WhileSubscribed(5_000),
    initialValue = UiState.Loading
)
```

`shareIn(scope, started, replay)` is the same for a `SharedFlow`.

`SharingStarted` options:

- `Eagerly`: starts now and never stops until the scope ends.
- `Lazily`: starts at the first subscriber, then never stops.
- `WhileSubscribed(stopTimeoutMillis)`: starts at the first subscriber and stops when the last one has been gone for the timeout.

### Why WhileSubscribed(5_000)

- When the app goes to the background, the UI stops collecting. After 5 seconds the upstream, like a database query or location updates, is stopped. This saves battery and data.
- A rotation recreates the Activity in well under 5 seconds. The upstream keeps running, so there is no restart and no repeated network call.

> **Pitfall:** `fun state() = flow.stateIn(...)` or a getter creates a new shared flow on every call. Assign it once to a `val`.

:::deeper One-off events
Events like "show a snackbar" or "navigate" must be handled exactly once.

| Approach | Pros | Cons |
|---|---|---|
| Channel plus receiveAsFlow | Buffers events while no one collects | One collector; rare loss during lifecycle changes |
| SharedFlow with replay 0 | Simple, many collectors | Events with no collector are lost |
| Event in UI state | Survives rotation and can be saved | UI must report that it handled the event |

```kotlin
// Channel
private val _events = Channel<Event>(Channel.BUFFERED)
val events = _events.receiveAsFlow()

// State-based (Google's guidance)
data class UiState(val userMessage: String? = null)
fun messageShown() = _state.update { it.copy(userMessage = null) }
```

Google's architecture guidance models events as **state** that the UI clears after handling. Many teams still use a `Channel` and accept the small risk. In an interview, explain the trade-offs instead of calling one perfect.

Collecting a channel of events on `Dispatchers.Main.immediate`, the default for `lifecycleScope`, shrinks the window where an event can be lost.
:::

:::check
Q: You call `_state.value = current` where `current` is the same list you just mutated with `add`. Does the UI update?
A: No. StateFlow compares with `equals`, and the list equals itself, so nothing is emitted. Create a new list, for example `current + item`.
Q: `val events = MutableSharedFlow<Event>()` and you call `events.tryEmit(Toast)` while the screen collects. What happens?
A: `tryEmit` returns false and the event is lost. With no replay and no extra buffer there is nowhere to put the value without suspending; use `emit`, or add `extraBufferCapacity`.
Q: Interview: Why use `stateIn` with `WhileSubscribed(5000)` instead of `Eagerly`?
A: It stops the upstream 5 seconds after the last collector leaves, so background apps stop doing work. A rotation finishes within the timeout, so the upstream is not restarted. `Eagerly` would keep it running for the whole ViewModel lifetime.
:::

## Testing coroutines and Flow

How to test suspend code, ViewModels and flows quickly and reliably with virtual time and Turbine.

:::tldr
- `runTest` runs the test with virtual time, so `delay` is instant, and it reports exceptions from leaked coroutines.
- Replace `Dispatchers.Main` with a `TestDispatcher` via `Dispatchers.setMain`, and inject other dispatchers.
- Test flows with Turbine's `test { awaitItem() }`, or collect in `backgroundScope`.
:::

### Setup

Add `kotlinx-coroutines-test`. For flows, add Turbine (`app.cash.turbine:turbine`).

### runTest

`runTest` runs the test body in a coroutine with **virtual time**. `delay` skips ahead instead of waiting. It waits for coroutines launched in the test to finish, and fails the test on uncaught exceptions.

```kotlin
@Test
fun loadsAfterDelay() = runTest {
    val repo = FakeRepo(delayMs = 10_000)
    val result = repo.load()       // returns instantly in real time
    assertEquals(expected, result)
    assertEquals(10_000, currentTime) // virtual milliseconds
}
```

### Test dispatchers

| Dispatcher | Behaviour |
|---|---|
| `StandardTestDispatcher` | Queues new coroutines; they run when the test yields or advances time. The default in `runTest`. |
| `UnconfinedTestDispatcher` | Starts new coroutines eagerly. Simpler, but can hide ordering bugs. |

Scheduler controls:

- `advanceUntilIdle()`: runs everything queued, including delays, until nothing is left.
- `advanceTimeBy(ms)`: moves virtual time forward. Tasks scheduled exactly at the new time do not run yet.
- `runCurrent()`: runs tasks scheduled at the current time.

```kotlin
@Test
fun standardDispatcherNeedsAdvancing() = runTest {
    var done = false
    launch { done = true }
    assertFalse(done)   // queued, not run yet
    advanceUntilIdle()
    assertTrue(done)
}
```

### Replacing Dispatchers.Main

`viewModelScope` uses `Dispatchers.Main`, which does not exist in local JVM tests. Replace it with a rule.

```kotlin
class MainDispatcherRule(
    val dispatcher: TestDispatcher = UnconfinedTestDispatcher()
) : TestWatcher() {
    override fun starting(description: Description) = Dispatchers.setMain(dispatcher)
    override fun finished(description: Description) = Dispatchers.resetMain()
}
```

When `Main` is a `TestDispatcher`, `runTest` and test dispatchers created later share its scheduler. Virtual time stays consistent across all of them.

> **Tip:** Inject `CoroutineDispatcher`s into repositories. In tests, pass a test dispatcher instead of `Dispatchers.IO`, so all work runs on the shared scheduler.

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

`awaitItem()` suspends until the next value. `awaitError()` and `awaitComplete()` check the end of the flow. `expectNoEvents()` asserts nothing new arrived.

### Without Turbine

Collect in `backgroundScope`. It is cancelled automatically when the test ends.

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

> **Pitfall:** A `stateIn(WhileSubscribed)` flow does not start its upstream until someone collects. Reading `.value` in a test with no collector returns only the initial value.

> **Note:** StateFlow conflates. If several values are set quickly, a collector may see only the last one. Assert on the final state, or test the intermediate values with a `SharedFlow` or the upstream flow.

:::check
Q: A test does `launch { done = true }` inside `runTest` and immediately asserts `done` is true. It fails. Why?
A: `runTest` uses `StandardTestDispatcher`, which only queues the new coroutine. Call `advanceUntilIdle()` or `runCurrent()` before the assert.
Q: A repository hardcodes `withContext(Dispatchers.IO)` and uses `delay(5_000)` for a retry. Why does its test take 5 real seconds?
A: `Dispatchers.IO` is not a test dispatcher, so its `delay` uses real time instead of the test scheduler. Inject the dispatcher and pass a test dispatcher in tests.
Q: Interview: How do you test a ViewModel that uses `viewModelScope`?
A: Replace `Dispatchers.Main` with a `TestDispatcher` through `Dispatchers.setMain`, usually in a JUnit rule, and run the test in `runTest`. Advance the scheduler for `StandardTestDispatcher`, use Turbine or a `backgroundScope` collector for flows, and inject other dispatchers so they share the scheduler.
:::

## Review and cheat sheet

One screen of everything in this topic, plus practice to lock it in.

:::tldr
- Skim the cheat sheet the night before an interview; each row maps to an earlier lesson.
- Know the pitfalls list cold: most coroutine interview questions are one of them.
- Do the five exercises; each one makes you explain a rule, not just use an API.
:::

### Cheat sheet

| Topic | Remember |
|---|---|
| Core idea | Suspend, not block; a dispatcher picks the thread |
| Under the hood | CPS: hidden `Continuation`, returns `Any?`, state machine with a `label` |
| Builders | `launch` gives `Job`, `async` gives `Deferred`; `runBlocking` never on main |
| Scopes | `coroutineScope` fails together, `supervisorScope` fails alone |
| withContext | Switches dispatcher and returns a result; makes functions main-safe |
| Context | `Job` + dispatcher + name + handler; `+` right side wins |
| Dispatchers | `Default` cores, `IO` 64 or more, `Main.immediate` skips a dispatch |
| limitedParallelism | `limitedParallelism(1)` is a serial queue |
| Structure | Parents wait, cancel flows down, failure flows up |
| Cancellation | Cooperative: `isActive`, `ensureActive()`, `yield()` |
| Cleanup | `finally` plus `withContext(NonCancellable)` for suspend calls |
| CancellationException | Never swallow it; watch `runCatching` and `catch (e: Exception)` |
| Errors | `launch` propagates at once; `async` at `await` and fails parent too |
| Handler | Only root `launch` or supervisor child; logging only |
| Android | `viewModelScope`, `lifecycleScope`: `SupervisorJob` + `Main.immediate` |
| UI collection | `repeatOnLifecycle(STARTED)`, `collectAsStateWithLifecycle()` |
| Long work | Injected app scope or WorkManager, never `GlobalScope` |
| Sync | `Mutex.withLock` (not reentrant), `Semaphore.withPermit`, `update { }` |
| Channels | Rendezvous 0, buffered 64, unlimited, conflated; one receiver per value |
| Flow | Cold, runs in collector context, `flowOn` moves upstream only |
| Builders for Flow | `channelFlow` for concurrent sends, `callbackFlow` needs `awaitClose` |
| Operators | `flatMapLatest` search, `combine` latest of all, `zip` pairs |
| Backpressure | `buffer`, `conflate`, `collectLatest` |
| Errors in Flow | `catch` is upstream only and ends the flow; `retryWhen` re-collects |
| StateFlow | Initial value, conflated, equals dedupe, `update { }` |
| SharedFlow | `replay`, `extraBufferCapacity`, `onBufferOverflow` |
| Sharing | `stateIn(scope, WhileSubscribed(5_000), initial)` in a `val` |
| Testing | `runTest`, `advanceUntilIdle()`, `setMain`, Turbine `awaitItem()` |

### The pitfalls that come up most

- Blocking calls like `Thread.sleep` or heavy CPU work on `Dispatchers.Main`.
- Swallowing `CancellationException` with `catch (e: Exception)` or `runCatching`.
- `launch(Job())` or `launch(SupervisorJob())` detaching work from its scope.
- A `CoroutineExceptionHandler` on a nested child, where it is ignored.
- `try/catch` around only `await()`; the failing `async` already failed the parent.
- Sequential `async { }.await()` calls that were meant to run in parallel.
- CPU loops with no `ensureActive()` or `yield()`, which ignore cancellation.
- Suspend calls in `finally` after cancel, without `NonCancellable`.
- Collecting in `lifecycleScope` without `repeatOnLifecycle`.
- `stateIn` in a function or getter, and mutating state objects in place.
- `withContext` or `try/catch` around `emit` inside `flow { }`.

### Practice exercises

1. **Parallel dashboard.** Write `suspend fun loadDashboard(): Dashboard` that loads profile, notifications and recommendations in parallel. If recommendations fail, show the rest with an empty list. If the profile fails, the whole call must fail. Use `coroutineScope`, `async`, and a local `try/catch` or `supervisorScope`.
2. **Search screen.** Build a ViewModel with a `MutableStateFlow<String>` query. Expose `StateFlow<SearchUiState>` using `debounce(300)`, `distinctUntilChanged`, `flatMapLatest`, `catch` inside the inner flow, and `stateIn(WhileSubscribed(5_000))`. Write a Turbine test that proves only the last query hits the repository.
3. **Wrap a listener.** Turn a callback-based connectivity listener into a `Flow<Boolean>` with `callbackFlow`. Make sure the listener is unregistered when the collector is cancelled. Test it with a fake that counts register and unregister calls.
4. **Token refresh race.** Ten coroutines call `getToken()` at the same time when the token is expired. Make sure only one network refresh happens using a `Mutex`. Then explain why `synchronized` is wrong here.
5. **Cancellation audit.** Take a function that parses a large file in a `for` loop on `Dispatchers.Default` and catches `Exception` to log errors. Fix it so it stops quickly on cancel, never swallows `CancellationException`, and always closes the file. Write a `runTest` test that cancels it halfway and checks the file was closed.

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

:::check
Q: A ViewModel does `viewModelScope.launch { runCatching { repo.load() }.onFailure { showError(it) } }`. The user leaves the screen mid-load. What goes wrong, and how do you fix it?
A: Cancellation throws `CancellationException`, `runCatching` catches it, and `showError` runs for a normal cancellation. Catch specific exceptions, or rethrow `CancellationException` before handling errors.
Q: A screen collects `uiState` with `collectAsState()` and the upstream polls the network. The user presses Home for ten minutes. What happens, and what two changes fix it?
A: `collectAsState()` keeps collecting in the background, so the polling never stops, whatever the sharing policy. Collect with `collectAsStateWithLifecycle()`, and share the flow with `stateIn(viewModelScope, WhileSubscribed(5_000), initial)` so the upstream stops in the background.
Q: Interview: Walk through what happens when a child `launch` inside `viewModelScope.launch { }` throws an `IOException`.
A: The child fails and cancels its parent, the outer `launch`, which cancels its other children. The outer coroutine is a direct child of the `SupervisorJob`, so siblings in `viewModelScope` keep running, but the exception is uncaught and goes to the handler or crashes the app unless caught inside.
:::
