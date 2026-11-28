## Mental model and composable rules

How Compose thinks about UI, what `@Composable` really does, and the five rules every composable must follow.

:::tldr
- Compose UI is a function of state: change the state and the UI follows; you never call setters on widgets.
- `@Composable` makes the compiler rewrite your function so the runtime can remember values, track state reads and skip work.
- A composable can run often, be skipped, run in any order, and must have no side effects in its body.
:::

### Declarative UI in one sentence

In the View system you build a tree of objects and then change them, like `textView.text = "Hi"`. In Compose you write functions that turn state into UI. When state changes, Compose calls the affected functions again and updates only what changed.

The core idea is `UI = f(state)`. You do not hold references to widgets. You do not call setters. You change state, and the UI follows.

```kotlin
@Composable
fun Greeting(name: String) {
    Text(text = "Hello, $name")
}
```

There is no `TextView` object you keep around. If `name` changes, the caller calls `Greeting` again with the new value. This re-run is called **recomposition**.

### What @Composable really means

`@Composable` tells the Compose compiler plugin to transform the function. The compiler adds hidden parameters: a `Composer` and some bit flags that describe which arguments changed.

That transform lets the runtime do three things:

- Remember values across calls (this is how `remember` works).
- Track which state each function reads.
- Skip a function when its inputs did not change.

Because of the hidden parameters, a composable can only be called from another composable, or from an entry point like `setContent`.

> **Note:** Since Kotlin 2.0 the Compose compiler ships with Kotlin itself. You apply the `org.jetbrains.kotlin.plugin.compose` Gradle plugin, and its version always matches your Kotlin version.

### Naming conventions

- A composable that emits UI returns `Unit` and uses a PascalCase noun: `ProfileCard`, `SearchBar`.
- A composable that returns a value starts with a lowercase letter and emits no UI: `remember`, `rememberScrollState`.
- Composables have no lifecycle callbacks of their own. They enter the composition, recompose zero or more times, and leave the composition.

### The five rules

Compose makes few promises about when and how often your function runs. Write every composable as if:

1. **It can run very often.** Possibly every frame during an animation. Keep it cheap. No disk or network work in the body.
2. **It can be skipped.** If its inputs did not change, Compose may not call it at all.
3. **It can run in any order.** Do not assume siblings run top to bottom and share data through globals.
4. **It is idempotent.** Same inputs, same UI.
5. **Its body has no side effects.** Writing to an outside variable, logging analytics or starting a request directly in the body is a bug. Use the side-effect APIs or event callbacks instead.

```kotlin
// BAD: side effect in the composition body
@Composable
fun ItemList(items: List<Item>) {
    var count = 0
    Column {
        items.forEach { count++; Text(it.name) }
        Text("Count: $count")
    }
}
```

This code looks fine but is fragile. The counting is a side effect hidden in the UI code, and it reruns on every recomposition. Just use `items.size`.

> **Interview:** "Composables must be side-effect free" means the body only describes UI. Anything that touches the outside world goes into `LaunchedEffect`, `DisposableEffect`, `SideEffect` or an event callback.

### Composition and identity

The first time Compose runs your UI tree, it builds the **composition**: a record of which composables were called and what each one remembered. On later changes it re-runs only the parts that read the changed state.

Compose identifies each call by its **position in the source code** (the call site) plus the order of calls. So two `Text` calls on different lines are different nodes, even with the same text.

Inside a loop, every item comes from the same call site. Position alone cannot tell them apart, so Compose falls back to call order. That is why `key {}` exists. Lesson 10 covers it.

> **Under the hood:** The composition is stored in a structure called the slot table, and state changes are tracked by the snapshot system. Working knowledge is enough here; the internals are a later topic.

:::deeper Compose vs the View system
| Aspect | View system | Compose |
|---|---|---|
| UI unit | `View` object | Composable function call |
| Updating | Call setters on views | Change state, Compose re-runs functions |
| Layout passes | Can measure children many times | Each child measured once per pass |
| Nesting cost | Deep nesting is slow | Deep nesting is cheap |
| Styling | XML styles and themes | Kotlin code, `MaterialTheme`, CompositionLocals |
| Shipping | Part of the Android OS | A library inside your APK |

The last row matters for performance. Because Compose ships with your app, its code is not precompiled by the OS. Lesson 15 explains how Baseline Profiles fix that.
:::

:::check
Q: A composable calls `analytics.logScreenView()` directly in its body. What goes wrong?
A: It logs on every recomposition, which may be many times, or never if the call is skipped. Move it into a `LaunchedEffect` keyed on the screen.
Q: Why can you not call a composable from a regular `onClick` lambda?
A: The compiler adds a hidden `Composer` parameter to composables. A plain lambda has no composer to pass, so the call does not compile. Change state in `onClick` instead and let the UI react.
Q: Interview: Explain `UI = f(state)` and why it makes UI easier to reason about.
A: The screen is a pure function of the current state, so the same state always produces the same UI. You never have to track a series of setter calls; you only make sure the state is correct.
:::

## The three phases

How a Compose frame is built in three steps, and why reading state later makes your UI cheaper.

:::tldr
- Each frame can run composition (what to show), layout (where to put it) and drawing (how it looks).
- A state change re-runs only the phase that read the state, plus the phases after it.
- Read fast-changing state as late as possible, using lambda versions of modifiers like `offset {}` and `graphicsLayer {}`.
:::

### Three phases, in order

| Phase | Question it answers | Typical work |
|---|---|---|
| Composition | What UI to show? | Runs composables, builds or updates the UI tree |
| Layout | Where to place it? | Measures children, decides sizes, places them |
| Drawing | How does it render? | Draws pixels into a canvas |

Data flows one way: composition, then layout, then drawing. Layout itself has two steps: **measure** and **place**.

Not every frame runs all three. If nothing changed in composition, Compose can jump straight to layout or draw.

### Where you read state matters

Compose tracks **where** a state value is read. When the state changes, Compose re-runs only the phase that read it, and the phases after it.

- Read in a composable body: change triggers composition, layout and draw.
- Read in a layout or placement block: change triggers layout and draw only.
- Read in a draw block: change triggers draw only.

So the rule is: **read fast-changing state as late as possible.** Scroll position and animation values are the classic cases. They change every frame.

### Deferring reads with lambda modifiers

Many modifiers have two versions. One takes a value. The other takes a lambda. The lambda version runs later, in layout or draw, so the state is read later too.

```kotlin
// Reads scroll in composition: recomposes on every scroll pixel
Box(Modifier.offset(y = (scrollState.value / 2).dp))

// Reads scroll in the placement step: no recomposition
Box(Modifier.offset { IntOffset(0, scrollState.value / 2) })
```

Common late-reading modifiers:

- `Modifier.offset { }` reads during placement.
- `Modifier.layout { measurable, constraints -> }` reads during layout.
- `Modifier.graphicsLayer { alpha = ...; translationX = ...; scaleX = ... }` reads when the layer is drawn.
- `Modifier.drawBehind { }` and `Modifier.drawWithContent { }` read during drawing.

### An animated color, done right

```kotlin
@Composable
fun PulsingBox() {
    val color by rememberInfiniteTransition(label = "pulse").animateColor(
        initialValue = Color.Red, targetValue = Color.Blue,
        animationSpec = infiniteRepeatable(tween(1000), RepeatMode.Reverse),
        label = "color"
    )
    // Modifier.background(color) would read color in composition: recompose every frame.
    Box(Modifier.size(64.dp).drawBehind { drawRect(color) })
}
```

`color` is a delegated `State`. Writing `color` inside `drawBehind` reads it in the draw phase. The animation now costs one redraw per frame, with no recomposition and no layout.

### Passing lambdas instead of values

The same idea works across your own composables. If a child only needs a value at layout or draw time, pass a lambda.

```kotlin
@Composable
fun Header(scrollProvider: () -> Int) {
    Image(
        painter = painterResource(R.drawable.banner),
        contentDescription = null,
        modifier = Modifier.graphicsLayer {
            translationY = -scrollProvider() / 2f
        }
    )
}

// Caller
Header(scrollProvider = { scrollState.value })
```

The parent never reads `scrollState.value` in composition. Only the `graphicsLayer` block reads it, during draw.

> **Tip:** A parameter of type `() -> Int` instead of `Int` is a cheap way to move a state read out of the parent's composition.

> **Pitfall:** Lambda modifiers help only when the state changes often. For values that change once (like a selected tab), the plain version is clearer and costs nothing extra.

:::deeper Layout inside a phase
Layout is not one big step. It is two:

1. **Measure:** each node receives constraints from its parent and reports a size.
2. **Place:** each node positions its children inside itself.

A read inside `Modifier.layout`'s measure code invalidates measure, place and draw. A read inside the placement lambda (the block passed to `layout(width, height) { }`) invalidates only placement and draw. That is why `offset {}` is cheaper than changing a size: it only re-places.
:::

:::check
Q: You animate alpha with `Modifier.alpha(animatedAlpha)`. Layout Inspector shows the composable recomposing every frame. What change fixes it?
A: Use `Modifier.graphicsLayer { alpha = animatedAlpha }`. The read moves to the draw phase, so the animation no longer triggers recomposition.
Q: A state is read only inside `Modifier.offset { }`. Which phases run when it changes?
A: Layout (placement) and drawing. Composition is skipped because no composable body read the state.
Q: Interview: Why is "read state as late as possible" good advice, and when is it not worth it?
A: Each phase is cheaper than the one before it, and Compose only reruns the phase that read the state. It pays off for values that change every frame, like scroll or animation; for rare changes the plain API is simpler.
:::

## State and recomposition

How Compose notices changes, how `remember` keeps values alive, and which state API to pick.

:::tldr
- Only writes to a Compose `State` that was read trigger recomposition; plain variables and in-place list changes do not.
- `remember` survives recomposition only; `rememberSaveable` also survives rotation and process death.
- `derivedStateOf` filters a fast-changing state into a slower result, so readers recompose less.
:::

### What triggers recomposition

Recomposition happens when a **Compose `State` object** that was read during composition is written to. Plain Kotlin variables do not trigger anything. A normal `MutableList` changed in place does not trigger anything.

Recomposition is **scoped**. Compose re-runs the smallest restartable scope that read the state, usually the nearest non-inline composable function, not the whole screen.

> **Note:** `Column`, `Row` and `Box` are inline functions, so they do not create their own recomposition scope. A state read inside a `Column` body recomposes the enclosing composable function.

### mutableStateOf and remember

```kotlin
@Composable
fun Counter() {
    var count by remember { mutableIntStateOf(0) }
    Button(onClick = { count++ }) {
        Text("Clicked $count times")
    }
}
```

- `mutableStateOf(x)` creates an observable `MutableState<T>`.
- `remember { }` stores the value in the composition so it survives recomposition. Without `remember`, `count` would reset to 0 every time.
- `remember(key1) { }` recalculates when `key1` changes.
- For primitives use `mutableIntStateOf`, `mutableFloatStateOf`, `mutableLongStateOf` or `mutableDoubleStateOf`. They avoid boxing.

`remember` survives recomposition but **not** configuration changes or process death. Its value is also dropped when the composable leaves the composition.

### rememberSaveable and Saver

`rememberSaveable` writes the value into the saved instance state `Bundle`. It survives rotation, process death and back stack restoration in Navigation.

```kotlin
var query by rememberSaveable { mutableStateOf("") }
```

It works out of the box for types a `Bundle` can hold: primitives, `String`, `Parcelable`. For other types, give it a `Saver`.

```kotlin
data class City(val name: String, val country: String)

val CitySaver = listSaver<City, Any>(
    save = { listOf(it.name, it.country) },
    restore = { City(it[0] as String, it[1] as String) }
)

var city by rememberSaveable(stateSaver = CitySaver) {
    mutableStateOf(City("Madrid", "Spain"))
}
```

Your options are `@Parcelize`, `mapSaver`, `listSaver` or a custom `Saver(save, restore)`.

> **Pitfall:** Do not put large objects in `rememberSaveable`. The Bundle has a size limit and a `TransactionTooLargeException` can crash the app. Save IDs, not data.

### derivedStateOf

Use `derivedStateOf` when a state changes **more often** than the result you need. It notifies readers only when the computed result actually changes.

```kotlin
val listState = rememberLazyListState()
val showScrollToTop by remember {
    derivedStateOf { listState.firstVisibleItemIndex > 0 }
}
```

The index changes on every scroll step, but the boolean flips rarely. Without `derivedStateOf`, every scroll step would recompose the reader.

> **Pitfall:** Do not use `derivedStateOf` when the output changes as often as the input, like `"$firstName $lastName"`. It only adds overhead. A plain expression or `remember(firstName, lastName) { }` is fine.

### Observable collections

```kotlin
val todos = remember { mutableStateListOf<Todo>() }
todos.add(Todo("Buy milk"))  // readers recompose
```

- `mutableStateListOf` and `mutableStateMapOf` are observable.
- `mutableStateOf(mutableListOf())` plus `list.add()` does **not** recompose, because the `State` still holds the same reference.
- In a ViewModel, prefer an immutable `List` inside a `StateFlow` and replace it: `_items.update { it + newItem }`.

### Other sources of state

Compose can also observe a `Flow` (`collectAsState`, `collectAsStateWithLifecycle`), `LiveData` (`observeAsState`) and RxJava (`subscribeAsState`). Each one turns the source into a `State<T>`, so Compose can track reads.

### Choosing where state lives

| Need | Use |
|---|---|
| Survive recomposition only | `remember` |
| Survive rotation and process death, small data | `rememberSaveable` |
| Screen data and business logic | `ViewModel` with `StateFlow` |
| Result that changes less often than its input | `remember { derivedStateOf { } }` |

:::deeper Backwards writes
Writing to a state after reading it in the same composition makes Compose recompose again, which writes again, forever.

```kotlin
@Composable
fun BadCounter() {
    var count by remember { mutableIntStateOf(0) }
    Text("$count")
    count++ // backwards write: infinite recomposition
}
```

Only write state from event callbacks or effects, never from the composition body.
:::

:::check
Q: `val items = remember { mutableStateOf(mutableListOf<String>()) }` and a click calls `items.value.add("x")`. Does the UI update?
A: No. The list changes in place but the `State` still points to the same object, so no write is detected. Use `mutableStateListOf` or assign a new list.
Q: The user types in a field backed by `remember { mutableStateOf("") }` and rotates the phone. What happens, and what is the fix?
A: The text is lost because the Activity is recreated and `remember` does not survive it. Use `rememberSaveable`, or keep the text in a ViewModel.
Q: Interview: When do you use `derivedStateOf`, and when is it a mistake?
A: Use it when a result changes less often than its input, like "scrolled past first item" from a scroll index. It is a mistake when the result changes as often as the input, because you pay tracking cost for nothing.
:::

## State hoisting and unidirectional data flow

How to move state up so components become reusable, and how state and events flow through a screen.

:::tldr
- State hoisting replaces a state variable with a `value` parameter and an `onValueChange` event.
- Hoist to the lowest common ancestor that reads or writes the state, and no higher.
- State flows down, events flow up; a ViewModel is the single source of truth for screen state.
:::

### Stateless vs stateful

A **stateful** composable owns its state with `remember`. A **stateless** composable receives state as parameters and reports events through lambdas.

```kotlin
// Stateless: easy to preview, test and reuse
@Composable
fun SearchBar(query: String, onQueryChange: (String) -> Unit, modifier: Modifier = Modifier) {
    TextField(value = query, onValueChange = onQueryChange, modifier = modifier)
}

// Stateful wrapper: convenient default
@Composable
fun SearchBar(modifier: Modifier = Modifier) {
    var query by rememberSaveable { mutableStateOf("") }
    SearchBar(query, { query = it }, modifier)
}
```

Offering both is a common library pattern. Callers who do not care get the simple version. Callers who need control use the stateless one.

### The hoisting pattern

**State hoisting** moves state to a caller so the child becomes stateless. You replace one state variable with two parameters:

- `value: T` is the current value to show.
- `onValueChange: (T) -> Unit` is an event asking to change it.

Hoisted state gives you:

- **A single source of truth.** No two copies that can disagree.
- **Encapsulation.** Only the owner can change the state.
- **Shareability.** Siblings can read the same state.
- **Interceptability.** The caller can validate or ignore an event before changing state.

### How high to hoist

Hoist state to the **lowest common ancestor** of all composables that read or write it. Do not hoist higher than needed. State that sits too high makes more of the tree recompose and spreads concerns around.

If a value is used only inside one component, like whether a dropdown is open, keep it inside that component.

### Unidirectional data flow

**State flows down. Events flow up.**

```text
ViewModel (StateFlow<UiState>)
   | state down
   v
Screen composable  --->  child composables
   ^
   | events up (onClick, onValueChange)
ViewModel.onEvent(...)
```

The UI never changes its own data directly. It sends an event. The owner updates state. The new state flows back down and the UI recomposes.

Benefits: one source of truth, predictable updates, and easy tests, because the UI is a pure function of state.

### Where state should live

| Kind of state | Where it lives |
|---|---|
| Simple UI element state (expanded, focus) | `remember` in the composable |
| UI state that must survive rotation | `rememberSaveable` |
| Complex UI logic with several related values | A plain state holder class, created with `remember` |
| Screen state from business logic | `ViewModel` exposing `StateFlow` |

### Plain state holders

When a component has several related state values and logic, group them in a class. This is how `LazyListState` and `ScrollState` work.

```kotlin
@Stable
class FilterPanelState(initiallyOpen: Boolean) {
    var isOpen by mutableStateOf(initiallyOpen)
        private set
    fun toggle() { isOpen = !isOpen }
}

@Composable
fun rememberFilterPanelState(open: Boolean = false) =
    remember { FilterPanelState(open) }
```

The `remember...` function follows the convention used by the Compose libraries. If the state must survive rotation, give the class a `Saver` and use `rememberSaveable`.

> **Tip:** Follow the API rules: `modifier: Modifier = Modifier` is the first optional parameter, applied to the root element, and never passed to several children.

> **Pitfall:** Do not keep a copy of a hoisted value in local `remember` state. The copy goes stale when the parent changes the value.

:::check
Q: A `Checkbox` keeps its own `remember { mutableStateOf(false) }` and also takes `checked` from the parent. The parent resets `checked` to false but the box stays ticked. Why?
A: There are two sources of truth and the box shows its local copy. Make it stateless: show `checked` and call `onCheckedChange`, letting the parent own the value.
Q: Two sibling composables need the same `selectedTab`. Where should the state live?
A: In their lowest common ancestor, usually the parent that calls both. Pass the value down and a callback to change it.
Q: Interview: What is state hoisting and why does it help?
A: Moving state to the caller and replacing it with a value plus an event lambda. The child becomes stateless, so it is reusable, previewable and testable, and the app gets one source of truth with unidirectional data flow.
:::

## Stability and skipping

When Compose can skip a composable, what stability means, and how strong skipping changed the rules.

:::tldr
- A child is skipped when it is skippable and all its arguments equal the previous ones.
- Since Kotlin 2.0.20 strong skipping is on by default: every restartable composable can skip, unstable params compare by `===`, lambdas are auto-remembered.
- The main risk now is creating new objects or lists on every recomposition, not stability annotations.
:::

### What skipping means

When a parent recomposes, Compose looks at each child call and asks: can I skip it? It skips the child if the child is **skippable** and every argument is equal to the previous call.

Skipping is the main reason Compose is fast. A screen with a hundred composables may only re-run two of them when one value changes.

### Stable types, in working terms

A type is **stable** if Compose can trust that equal values mean equal UI, and that any change to it will be noticed.

- Primitives, `String` and function types are stable.
- A class whose properties are all `val` of stable types is inferred stable by the compiler.
- A class with any `var` that is not backed by a Compose `State` is unstable.
- `List`, `Set` and `Map` are **unstable**, because the interface could hide a mutable implementation.
- Classes from modules not built with the Compose compiler are unstable unless you configure them.

### @Immutable and @Stable

- `@Immutable` promises that no public property changes after construction.
- `@Stable` promises that `equals` is consistent and that any public property change is observable by Compose, usually because it is backed by `mutableStateOf`.

These are **promises**. The compiler does not check them. If you lie, the UI may not update.

```kotlin
@Immutable
data class ProfileUi(val name: String, val tags: List<String>)
```

### Strong skipping mode

Since Kotlin 2.0.20, **strong skipping is on by default**. It changes two rules:

- **All restartable composables become skippable**, even with unstable parameters.
  - Unstable parameters are compared by **instance equality** (`===`).
  - Stable parameters are still compared with `equals()`.
- **Lambdas are remembered automatically**, including lambdas that capture unstable values. The remembered lambda is keyed on its captured values.

So stability still matters, but less. An unstable `List` that is the **same instance** lets the child skip. A new list with the same contents does not.

```kotlin
@Composable
fun Screen(users: List<User>) {
    // New list every recomposition: UserList cannot skip
    UserList(users.filter { it.active })

    // Same instance until users changes: UserList can skip
    val active = remember(users) { users.filter { it.active } }
    UserList(active)
}
```

> **Interview:** With strong skipping, "make everything stable" is no longer the first advice. Focus on avoiding new instances each recomposition and reading state in the right phase.

### Handling collections

If a type with a `List` must compare by `equals`, you have three choices:

1. Use `ImmutableList` or `PersistentList` from `kotlinx.collections.immutable`. The compiler treats them as stable.
2. Wrap the list in an `@Immutable` class.
3. List the types in a **stability configuration file**.

```kotlin
// module build.gradle.kts
composeCompiler {
    stabilityConfigurationFiles.add(
        rootProject.layout.projectDirectory.file("compose_stability.conf")
    )
}
```

The file holds one class name per line, like `kotlin.collections.List` or `com.example.domain.*`.

### Lambdas and method references

Before strong skipping, passing `viewModel::onClick` or a lambda that captured an unstable value could break skipping. People wrapped lambdas in `remember` by hand.

Now the compiler does that for you. You rarely need to `remember` a lambda manually.

> **Tip:** `@NonRestartableComposable` and `@NonSkippableComposable` exist for rare cases. If you see them often in code review, ask why.

:::deeper Why equals for stable, === for unstable
For a stable type, `equals` is trusted to mean "same UI", so comparing contents is safe.

For an unstable type, Compose cannot trust `equals`. The object might change after the comparison, so two "equal" objects could later differ. Instance equality is the only safe check: if it is the very same object and its changes are not observable, Compose assumes the parent passed the same thing on purpose.
:::

:::check
Q: With strong skipping on, a parent passes `items.sortedBy { it.name }` to `ItemList` on every recomposition. Does `ItemList` skip when nothing changed?
A: No. `sortedBy` creates a new `List` each time and unstable params compare by `===`. Wrap it in `remember(items) { }` or sort in the ViewModel.
Q: A class is marked `@Immutable` but has a `var count: Int` that code changes. What can go wrong?
A: Compose trusts the promise and may skip composables that receive it, so the UI shows the old count. Annotations are not verified.
Q: Interview: What does stability mean, and how did strong skipping change it?
A: A stable type lets Compose trust `equals` and see changes, so it can skip safely. Before strong skipping, any unstable parameter blocked skipping. Now all restartable composables can skip, unstable params use `===` and lambdas are remembered, so the main risk is new instances on every recomposition.
:::

## Side effects

The controlled ways to run work that touches the outside world, and how effect keys decide when that work restarts.

:::tldr
- `LaunchedEffect` runs suspend work tied to composition; it restarts when a key changes and cancels when it leaves.
- `DisposableEffect` is for register and unregister pairs; `SideEffect` runs after every successful recomposition.
- `rememberUpdatedState` gives a long effect the newest value without restarting it; `rememberCoroutineScope` is for launching from callbacks.
:::

### LaunchedEffect

Runs a suspend block in a coroutine scoped to the composition. It is cancelled when the composable leaves. When any key changes, it is cancelled and launched again.

```kotlin
@Composable
fun SnackbarOnError(error: String?, snackbarHost: SnackbarHostState) {
    LaunchedEffect(error) {
        if (error != null) snackbarHost.showSnackbar(error)
    }
}
```

> **Pitfall:** `LaunchedEffect(Unit)` runs once per entry into the composition. If the block uses a value that can change, add it as a key or read it through `rememberUpdatedState`.

### DisposableEffect

For effects that need cleanup. The block must end with `onDispose { }`, which runs when the key changes or the composable leaves.

```kotlin
@Composable
fun LifecycleLogger(lifecycleOwner: LifecycleOwner = LocalLifecycleOwner.current) {
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event -> Log.d("LC", "$event") }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
}
```

Use it for listeners, callbacks, broadcast receivers and sensors.

### SideEffect

Runs after **every successful recomposition**. Use it to publish Compose state to code that Compose does not manage.

```kotlin
SideEffect {
    analytics.setUserProperty("theme", themeName)
}
```

### rememberCoroutineScope

Gives a `CoroutineScope` tied to the composition, for launching coroutines **from event callbacks**. You cannot call `LaunchedEffect` inside an `onClick`, because `onClick` is not composable.

```kotlin
val scope = rememberCoroutineScope()
Button(onClick = { scope.launch { drawerState.open() } }) { Text("Menu") }
```

### rememberUpdatedState

A long-running effect captures values when it starts. `rememberUpdatedState` lets it use the latest value **without restarting**.

```kotlin
@Composable
fun SplashScreen(onTimeout: () -> Unit) {
    val currentOnTimeout by rememberUpdatedState(onTimeout)
    LaunchedEffect(Unit) {
        delay(2_000)
        currentOnTimeout() // newest lambda, timer not restarted
    }
}
```

If you used `onTimeout` as the key instead, a new lambda from the parent would restart the two-second timer.

### produceState

Turns a non-Compose data source into `State`. It launches a coroutine and you set `value`.

```kotlin
@Composable
fun rememberImage(url: String, repo: ImageRepo): State<ImageResult> =
    produceState<ImageResult>(initialValue = ImageResult.Loading, url) {
        value = repo.load(url)
    }
```

Inside it you can call `awaitDispose { }` to clean up callback-based sources.

### snapshotFlow

The reverse direction: turns Compose state reads into a cold `Flow`. It emits when the read state changes to a value not equal to the last one.

```kotlin
LaunchedEffect(listState) {
    snapshotFlow { listState.firstVisibleItemIndex }
        .filter { it > 10 }
        .collect { analytics.logScrolledDeep() }
}
```

Use it to connect state to coroutine logic: analytics, saving drafts, debounced search.

### Decision table

| Need | Use |
|---|---|
| Run suspend work when a key changes | `LaunchedEffect(key)` |
| Register and unregister a listener | `DisposableEffect(key)` |
| Push Compose state to non-Compose code after each recomposition | `SideEffect` |
| Launch a coroutine from a click | `rememberCoroutineScope` |
| Newest value inside a long effect without restart | `rememberUpdatedState` |
| Callback or suspend source into State | `produceState` |
| Compose state into a Flow | `snapshotFlow` |

> **Interview:** Effect keys are restart triggers. Too few keys means stale values; too many means the effect restarts too often.

> **Note:** `LocalLifecycleOwner` now lives in `androidx.lifecycle.compose` (lifecycle-runtime-compose). The old one in `androidx.compose.ui.platform` is deprecated.

:::check
Q: A screen calls `LaunchedEffect(Unit) { repo.load(userId) }`. The parent later passes a new `userId`. What happens?
A: Nothing reloads, because the key `Unit` never changes and the block captured the old `userId`. Use `LaunchedEffect(userId)`.
Q: Why is `DisposableEffect` better than `LaunchedEffect` for adding a location listener?
A: `onDispose` guarantees the matching remove call when the key changes or the composable leaves. A listener added in `LaunchedEffect` has no natural cleanup point and would leak.
Q: Interview: `LaunchedEffect` vs `rememberCoroutineScope`?
A: `LaunchedEffect` starts a coroutine as part of composition, restarts on key change and cancels on leave. `rememberCoroutineScope` gives you a scope to launch from callbacks like clicks, which run outside composition.
:::

## CompositionLocal

How to pass values down the tree without parameters, the two kinds of locals, and when not to use them.

:::tldr
- A CompositionLocal passes a value implicitly to everything below its provider.
- `compositionLocalOf` recomposes only readers on change; `staticCompositionLocalOf` recomposes the whole subtree but reads are cheaper.
- Use it for tree-wide values with good defaults like theme tokens; never for screen data or ViewModels.
:::

### What it is

Normally data reaches a composable through parameters. Some values are needed almost everywhere: colors, text styles, the `Context`. Threading them through every function would be noisy.

A `CompositionLocal` solves this. You **provide** a value at some point in the tree. Everything below can **read** it with `.current`.

Compose itself uses many locals:

- Material: `LocalContentColor`, `LocalTextStyle`.
- Android: `LocalContext`, `LocalConfiguration`, `LocalDensity`, `LocalLifecycleOwner`.
- UI: `LocalLayoutDirection`, `LocalFocusManager`, `LocalSoftwareKeyboardController`.

`MaterialTheme.colorScheme` is itself backed by a CompositionLocal.

### Creating and providing one

```kotlin
data class Spacing(val small: Dp = 4.dp, val medium: Dp = 8.dp, val large: Dp = 16.dp)
val LocalSpacing = staticCompositionLocalOf { Spacing() }

@Composable
fun AppTheme(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalSpacing provides Spacing()) {
        MaterialTheme(content = content)
    }
}

// Anywhere below:
val spacing = LocalSpacing.current
```

- The lambda passed to `staticCompositionLocalOf` is the **default**, used when no provider exists above.
- `CompositionLocalProvider` can take several values: `LocalA provides a, LocalB provides b`.
- A nested provider overrides the value for its own subtree only.

### Static vs dynamic

| API | When the value changes | Best for |
|---|---|---|
| `compositionLocalOf` | Only composables that read `.current` recompose | Values that may change |
| `staticCompositionLocalOf` | The whole content of the provider recomposes | Values that rarely or never change |

`staticCompositionLocalOf` is cheaper to read, because Compose does not track each reader. The cost is paid only when the value changes. For theme tokens, injected services and loggers, that almost never happens.

### When to use it

Good fits:

- Cross-cutting values with a sensible default: theme, spacing, an image loader, analytics logger.
- Values whose scope is truly the tree, like content color under a `Surface`.

Bad fits:

- Screen data, user objects, ViewModels.
- Anything most composables in the tree do not need.

Locals hide dependencies. A composable that reads a local has an input you cannot see in its signature. That makes previews and tests harder and breaks the "explicit inputs" model.

> **Pitfall:** Prefer explicit parameters. If a value has no good default, or most of the tree does not need it, do not make it a CompositionLocal.

### Defaults that fail loudly

Sometimes there is no safe default. Then make the default throw, so a missing provider is found at once.

```kotlin
val LocalAnalytics = staticCompositionLocalOf<Analytics> {
    error("No Analytics provided")
}
```

In previews and tests, provide a fake:

```kotlin
CompositionLocalProvider(LocalAnalytics provides FakeAnalytics()) {
    ProfileScreen(state = previewState)
}
```

### Brand tokens beyond Material

A common pattern is to expose your own tokens next to Material's:

```kotlin
object AppTheme {
    val spacing: Spacing
        @Composable @ReadOnlyComposable
        get() = LocalSpacing.current
}

// Usage
Column(Modifier.padding(AppTheme.spacing.medium)) { }
```

`@ReadOnlyComposable` tells the compiler the getter only reads and emits nothing, so it can skip some bookkeeping.

> **Tip:** Read `.current` once at the top of a composable and pass the value to helpers that are not composable.

:::check
Q: A `compositionLocalOf` holds a user's font scale preference. It changes. Which composables recompose?
A: Only those that read `.current` of that local. With `staticCompositionLocalOf`, everything inside the provider's content would recompose.
Q: A teammate puts the `ProfileViewModel` in a CompositionLocal so deep children can call it. What do you say in review?
A: It hides a dependency, kills previews and tests, and couples leaf UI to a ViewModel. Pass plain state down and events up with lambdas instead.
Q: Interview: `compositionLocalOf` vs `staticCompositionLocalOf`?
A: The first tracks readers and recomposes only them on change. The static one does not track, so a change recomposes the whole subtree, but reads are cheaper. Use static for values that rarely change, like theme tokens.
:::

## Modifiers

Why modifier order changes the result, how to write reusable modifiers, and the basics of `Modifier.Node`.

:::tldr
- Modifiers apply in order, outside in: each one wraps everything after it.
- Accept `modifier: Modifier = Modifier` and apply it first on your root element.
- For custom modifiers, chain existing ones first; for low-level needs use `Modifier.Node`, not `composed {}`.
:::

### Order matters

Each modifier wraps everything after it. Read a chain from left to right as "from outside in". Changing the order changes the result.

```kotlin
// Padding outside the background: blue box with a transparent margin
Modifier.padding(16.dp).background(Color.Blue)

// Background outside the padding: blue fills the padded area too
Modifier.background(Color.Blue).padding(16.dp)
```

```kotlin
// Click area includes the padding
Modifier.clickable { }.padding(16.dp)

// Click area excludes the padding
Modifier.padding(16.dp).clickable { }
```

```kotlin
// Clip first, then background: rounded blue card
Modifier.clip(RoundedCornerShape(12.dp)).background(Color.Blue)

// Background first, then clip: the background keeps square corners
Modifier.background(Color.Blue).clip(RoundedCornerShape(12.dp))
```

Clip affects only what comes after it. A background drawn before the clip is not clipped. The same goes for the ripple of `clickable`: put `clip` before `clickable` so the ripple is rounded too.

### Size modifiers

The outer constraint usually wins. `Modifier.size(100.dp).size(50.dp)` gives 100dp, because the first `size` already fixed the constraints the second one receives.

- `size`, `width`, `height` respect the incoming constraints.
- `requiredSize` forces a size even against them. The content may then overflow its slot.
- `fillMaxWidth(0.5f)` takes a fraction of the available width.
- `wrapContentSize()` lets content be smaller than a forced minimum and aligns it.

### Chaining and reuse

- Modifiers are immutable values. You can store them: `val cardModifier = Modifier.padding(8.dp).fillMaxWidth()`.
- Use `then` to combine two chains: `modifier.then(Modifier.border(1.dp, Color.Gray))`.
- Conditional: `Modifier.then(if (selected) Modifier.border(2.dp, Color.Red) else Modifier)`.
- Apply the caller's `modifier` **first** on your root: `Box(modifier.padding(8.dp))`. The caller then controls the outer layout.

> **Pitfall:** Never pass the same `modifier` parameter to two children. Sizes and paddings meant for the root would apply twice.

### Scoped modifiers

Some modifiers only exist inside certain scopes:

- `Modifier.weight()` inside `RowScope` or `ColumnScope`.
- `Modifier.align()` inside `BoxScope`, `RowScope` or `ColumnScope`.
- `Modifier.animateItem()` inside `LazyItemScope`.

Because they are scope extensions, you cannot call `weight` inside a `Box`. The compiler stops you.

### Custom modifiers

There are three ways to build one:

1. **Chain existing modifiers** in an extension function. Simplest, best default.
2. **`composed { }`**: the old way. Discouraged now because of its performance cost.
3. **`Modifier.Node`**: the recommended low-level API. The built-in modifiers use it.

```kotlin
fun Modifier.card(): Modifier = this
    .clip(RoundedCornerShape(12.dp))
    .background(Color.White)
    .padding(16.dp)
```

### Modifier.Node basics

A `Modifier.Node` setup has two parts. A `ModifierNodeElement` is a cheap data class that Compose compares across recompositions. A `Modifier.Node` is a long-lived object that does the work.

```kotlin
private class CircleNode(var color: Color) : Modifier.Node(), DrawModifierNode {
    override fun ContentDrawScope.draw() {
        drawCircle(color)
        drawContent()
    }
}

private data class CircleElement(val color: Color) : ModifierNodeElement<CircleNode>() {
    override fun create() = CircleNode(color)
    override fun update(node: CircleNode) { node.color = color }
}

fun Modifier.circleBackground(color: Color): Modifier = this then CircleElement(color)
```

- `create()` runs once, when the modifier first appears.
- `update()` runs when the element is not equal to the previous one. The node is reused, not recreated.
- A node implements interfaces for what it does: `DrawModifierNode`, `LayoutModifierNode`, `PointerInputModifierNode`, `SemanticsModifierNode`, `CompositionLocalConsumerModifierNode` and more.

> **Under the hood:** Modifier.Node avoids allocations on recomposition and lets each node invalidate only its own phase. That is why the built-in modifiers moved to it.

:::check
Q: A card uses `Modifier.clickable { }.clip(RoundedCornerShape(16.dp))`. The ripple shows square corners. Why, and what is the fix?
A: `clickable` comes before `clip`, so its ripple is drawn outside the clipped area. Put `clip` first: `Modifier.clip(shape).clickable { }`.
Q: What size is `Box(Modifier.size(100.dp).size(50.dp))`?
A: 100dp. The first `size` fixes the constraints at 100dp, and the second one has to fit inside them. Use `requiredSize` to force 50dp.
Q: Interview: Why did Compose move custom modifiers from `composed {}` to `Modifier.Node`?
A: `composed` ran composition for every modifier instance and allocated on each recomposition. `Modifier.Node` keeps a long-lived node, updates it only when the element changes, and invalidates just the phase it affects.
:::

## Layouts

How Compose measures and places UI, from `Row` and `Column` to custom layouts, intrinsics and `SubcomposeLayout`.

:::tldr
- Parents pass constraints down, children return sizes up, then parents place children.
- Each child may be measured only once per pass, which keeps deep nesting cheap.
- Use intrinsics to size from children before measuring; use `SubcomposeLayout` only when content depends on measured size.
:::

### Row, Column, Box

```kotlin
Row(
    modifier = Modifier.fillMaxWidth().padding(16.dp),
    horizontalArrangement = Arrangement.SpaceBetween,
    verticalAlignment = Alignment.CenterVertically
) {
    Text("Title", Modifier.weight(1f))
    Icon(Icons.Default.Star, contentDescription = "Favorite")
}
```

- **Arrangement** controls spacing on the main axis: `Start`, `Center`, `SpaceBetween`, `SpaceEvenly`, `spacedBy(8.dp)`.
- **Alignment** controls position on the cross axis.
- `Modifier.weight(1f)` shares the remaining space. Weighted children are measured after the unweighted ones.
- `Box` stacks children. Use `Modifier.align(Alignment.BottomEnd)` on a child or `contentAlignment` on the Box.
- `FlowRow` and `FlowColumn` wrap children onto new lines, handy for chips.

### Constraints and the single-pass rule

Layout works top-down for constraints and bottom-up for sizes:

1. A parent passes **constraints** (min and max width and height) to each child.
2. Each child measures itself and returns a **size** within those constraints.
3. The parent decides each child's position and places it.

**Each child may be measured only once per layout pass.** Measuring a child twice throws. This keeps layout linear in the number of nodes, so deep nesting stays cheap.

> **Interview:** In Views, nested `LinearLayout` with weights could measure children many times, so deep trees got slow. Compose forbids double measurement, so nesting `Row` and `Column` is cheap.

### ConstraintLayout

`ConstraintLayout` for Compose lives in a separate artifact, `constraintlayout-compose`. Use it for complex relative positions, barriers, guidelines and chains.

In Compose it is a **readability** choice, not a performance fix. Nested rows and columns are already cheap.

### Custom Layout

```kotlin
@Composable
fun SimpleColumn(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Layout(content = content, modifier = modifier) { measurables, constraints ->
        val placeables = measurables.map { it.measure(constraints.copy(minHeight = 0)) }
        val width = placeables.maxOfOrNull { it.width } ?: 0
        val height = placeables.sumOf { it.height }
        layout(width.coerceIn(constraints.minWidth, constraints.maxWidth),
               height.coerceIn(constraints.minHeight, constraints.maxHeight)) {
            var y = 0
            placeables.forEach { it.placeRelative(0, y); y += it.height }
        }
    }
}
```

- `measure` returns a `Placeable` with a size.
- `layout(w, h) { }` reports your own size, then places children.
- `placeRelative` mirrors positions in right-to-left layouts. `place` does not.
- For a single element, use `Modifier.layout { measurable, constraints -> }`.

### Intrinsic measurements

Sometimes a parent needs a child's size **before** measuring it. For example, a divider in a row should be as tall as the tallest text. Intrinsics let you ask a child for its min or max intrinsic size without measuring it.

```kotlin
Row(Modifier.height(IntrinsicSize.Min)) {
    Text("Left", Modifier.weight(1f))
    VerticalDivider(Modifier.fillMaxHeight())
    Text("Right\nTwo lines", Modifier.weight(1f))
}
```

The row asks its children for their minimum intrinsic height and uses the largest. The divider then fills that height, not the whole screen.

### SubcomposeLayout and BoxWithConstraints

`SubcomposeLayout` lets you **compose** content during the layout phase, so what you compose can depend on measured sizes. `LazyColumn`, `Scaffold` and `BoxWithConstraints` are built on it.

```kotlin
BoxWithConstraints {
    if (maxWidth < 600.dp) CompactLayout() else ExpandedLayout()
}
```

> **Pitfall:** Subcomposition costs more than normal layout. Do not use `BoxWithConstraints` just to read a width. For window-level decisions, use window size classes from `currentWindowAdaptiveInfo()`; for simple cases use weights or `Modifier.layout`.

:::deeper Intrinsics vs SubcomposeLayout
| Need | Tool |
|---|---|
| Size siblings to the tallest or widest child | `IntrinsicSize.Min` or `Max` |
| Choose different content based on available size | `BoxWithConstraints` or window size classes |
| Measure one slot, then compose another with that size | `SubcomposeLayout` |

Intrinsics do not break the single-pass rule. They ask a separate question ("how big would you be?") before the real measure. They can still be costly in deep trees, because each intrinsic query walks the children.
:::

:::check
Q: A custom `Layout` calls `measurable.measure(constraints)` twice on the same child to try two sizes. What happens?
A: It throws at runtime, because a child may be measured only once per pass. Use intrinsic queries or `SubcomposeLayout` instead.
Q: A `VerticalDivider` with `fillMaxHeight()` inside a `Row` stretches to the full screen. How do you make it match the tallest text?
A: Give the row `Modifier.height(IntrinsicSize.Min)`, so its height comes from the children's intrinsic heights and the divider fills only that.
Q: Interview: Why is deep nesting cheap in Compose but expensive in Views?
A: Compose measures each child once per pass, so layout is linear in the number of nodes. Views allowed repeated measurement, like weighted `LinearLayout` or `RelativeLayout`, which multiplied work at each nested level.
:::

## Lazy lists and grids

How lazy layouts compose only what is visible, and how keys, content types and lean items keep them smooth.

:::tldr
- Lazy layouts compose and lay out only visible items plus a small prefetch.
- Give items a stable unique `key` so state and animations follow the data, not the position.
- Add `contentType` for mixed lists, keep item code light, and never nest an unbounded lazy list in a scroll of the same direction.
:::

### Basics

`LazyColumn`, `LazyRow`, `LazyVerticalGrid`, `LazyHorizontalGrid`, `LazyVerticalStaggeredGrid` and the pagers compose only the visible items, plus a small prefetch.

```kotlin
LazyColumn(
    contentPadding = PaddingValues(16.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp)
) {
    item { Header() }
    items(
        items = messages,
        key = { it.id },
        contentType = { it.type }
    ) { message ->
        MessageRow(message, Modifier.animateItem())
    }
}
```

The lambda is a DSL, not a composable. You describe items with `item`, `items` and `itemsIndexed`, and Compose composes them on demand.

Grids take a column rule: `GridCells.Fixed(3)` or `GridCells.Adaptive(minSize = 120.dp)`. A grid item can span columns with `span = { GridItemSpan(maxLineSpan) }`.

### Keys

By default an item's identity is its **position**. Insert one item at the top and every item shifts. Remembered state, like an expanded card, now belongs to the wrong item.

- `items(key = { it.id })` gives each item a stable identity. State and scroll position follow the item.
- Keys enable item animations with `Modifier.animateItem()`.
- Keys must be unique. Duplicate keys crash.
- On Android, keys must be types a `Bundle` can save (String, Int, Long, Parcelable), because they are saved for scroll restoration.

Outside lazy lists, use the `key` composable inside loops:

```kotlin
Column {
    for (movie in movies) {
        key(movie.id) {
            MovieOverview(movie)
        }
    }
}
```

### contentType

`contentType` tells Compose which items share a structure. Compose reuses compositions only between items of the same type. In a mixed list of headers, ads and rows, this makes reuse much more effective.

### Scroll state

`rememberLazyListState()` gives you the scroll position and lets you scroll in code.

```kotlin
val listState = rememberLazyListState()
val showFab by remember { derivedStateOf { listState.firstVisibleItemIndex > 3 } }
val scope = rememberCoroutineScope()

if (showFab) {
    FloatingActionButton(onClick = { scope.launch { listState.animateScrollToItem(0) } }) {
        Icon(Icons.Default.ArrowUpward, contentDescription = "Scroll to top")
    }
}
```

`firstVisibleItemIndex` changes on every scroll, so always read it through `derivedStateOf`.

### Performance tips

- Always provide `key` for dynamic data.
- Provide `contentType` for mixed lists.
- Keep item composables light. Sort, filter and format in the ViewModel, not inside `items {}`.
- Avoid zero-sized items, such as images before they load. Give placeholders a size, or Compose composes too many items on the first pass.
- Pass item data that does not change identity on every update, so rows can skip.
- Measure in a **release** build with R8. Debug builds are much slower.

> **Pitfall:** Never put a `LazyColumn` inside a `Column` with `verticalScroll` and no height limit. The inner list gets an infinite max height and crashes. Use one `LazyColumn` with several `item` and `items` blocks.

> **Interview:** "Why is my LazyColumn janky?" Check: debug build, missing keys, heavy item composition, item data rebuilt every recomposition, images without a fixed size, and work in the composition body.

:::deeper Paging and sticky headers
- `stickyHeader { }` pins a header while its section scrolls. Use it for grouped lists like contacts.
- With Paging 3, collect `pager.flow.collectAsLazyPagingItems()` and use `items(count = items.itemCount, key = items.itemKey { it.id })`. Read each item with `items[index]`, which also triggers loading.
- `HorizontalPager` and `VerticalPager` are lazy too, and accept `key` and `beyondViewportPageCount`.
:::

:::check
Q: A list without keys lets users expand a row. After a new message is inserted at the top, the wrong row is expanded. Why?
A: Without keys, identity is the index. The insert shifts every item down, but remembered state stays at its old index. Add `key = { it.id }`.
Q: A list uses `key = { it.hashCode() }` on a data class that changes when the user likes a post. What goes wrong?
A: The key changes when the data changes, so Compose treats it as a new item and drops its state and scroll anchor. Use a stable ID, not a content hash.
Q: Interview: Why do LazyColumn items need keys, and what does `contentType` add?
A: Keys give items a stable identity, so state, scroll position and `animateItem()` follow the data instead of the index. `contentType` lets Compose reuse compositions only between items of the same shape, which helps mixed lists.
:::

## Theming

How Material 3 theming works in Compose: color roles, typography, shapes, dark mode and dynamic color.

:::tldr
- `MaterialTheme` provides a color scheme, typography and shapes to everything below it.
- Use semantic roles like `primary` and `onSurface`, never hard-coded colors.
- Dynamic color uses the wallpaper on Android 12+; always keep a fallback light and dark scheme.
:::

### A typical app theme

```kotlin
@Composable
fun AppTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val ctx = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
        }
        darkTheme -> DarkColors
        else -> LightColors
    }
    MaterialTheme(colorScheme, typography = AppTypography, shapes = AppShapes, content = content)
}
```

`DarkColors` and `LightColors` are built with `darkColorScheme(...)` and `lightColorScheme(...)`. The Material Theme Builder tool can generate them from a brand color.

### The three parts

- **colorScheme:** semantic roles like `primary`, `onPrimary`, `secondaryContainer`, `surface`, `onSurface`, `surfaceContainer`, `error`.
- **typography:** text styles like `displayLarge`, `titleMedium`, `bodyLarge`, `labelSmall`.
- **shapes:** corner shapes from `extraSmall` to `extraLarge`.

Read them through `MaterialTheme.colorScheme.primary`, `MaterialTheme.typography.titleLarge` and `MaterialTheme.shapes.medium`.

### Color roles, not colors

Each role has a matching "on" role for content drawn on top of it: `primary` and `onPrimary`, `surface` and `onSurface`. If you use roles, dark mode and dynamic color just work.

```kotlin
// Good: adapts to light, dark and dynamic color
Text("Saved", color = MaterialTheme.colorScheme.onPrimaryContainer)

// Bad: unreadable in dark mode
Text("Saved", color = Color(0xFF1A1A1A))
```

`Surface` sets `LocalContentColor` to the matching "on" color. So `Text` inside a `primary` surface uses `onPrimary` automatically, without you passing a color.

Material 3 also has **surface container** roles (`surfaceContainerLowest` up to `surfaceContainerHighest`). They replace the old way of showing elevation with a tint.

### Dark mode

- `isSystemInDarkTheme()` reads the system setting.
- Provide both a light and a dark scheme.
- If the app has its own theme switch, store the choice (for example in DataStore) and pass it as `darkTheme`.

```kotlin
val mode by settingsViewModel.themeMode.collectAsStateWithLifecycle()
val dark = when (mode) {
    ThemeMode.System -> isSystemInDarkTheme()
    ThemeMode.Dark -> true
    ThemeMode.Light -> false
}
AppTheme(darkTheme = dark) { AppNavHost() }
```

### Dynamic color

Dynamic color (Material You) builds a scheme from the user's wallpaper on Android 12 (API 31) and above. On older devices you fall back to your own schemes.

Some brands turn it off so the app always uses brand colors. A middle ground is dynamic color on by default with a setting to turn it off.

### Typography

```kotlin
val AppTypography = Typography(
    titleLarge = TextStyle(fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 22.sp),
    bodyLarge = TextStyle(fontFamily = Inter, fontSize = 16.sp, lineHeight = 24.sp)
)
```

You override only the styles you need. The rest keep Material defaults. Use `sp` for text so it follows the user's font size setting.

> **Tip:** For brand tokens Material does not cover, like spacing or extra colors, add your own CompositionLocals and expose them through an object such as `AppTheme.spacing`.

> **Pitfall:** Do not read `MaterialTheme.colorScheme` outside the `AppTheme` call. You get the default purple baseline scheme, not yours.

:::deeper Status bar and edge-to-edge
On Android 15 and above, apps targeting SDK 35 are edge-to-edge by default. Call `enableEdgeToEdge()` in `onCreate` so older versions behave the same.

Then handle insets in Compose. `Scaffold` passes `innerPadding` to its content; apply it. For custom screens use `Modifier.windowInsetsPadding(WindowInsets.safeDrawing)` or `Modifier.systemBarsPadding()`. Status bar icon colors follow the light or dark theme through `enableEdgeToEdge`'s `SystemBarStyle`.
:::

:::check
Q: A screen looks fine in light mode, but in dark mode one label is black on dark grey. What is the likely cause?
A: The label uses a hard-coded color instead of a role like `onSurface`. Roles switch with the scheme; a fixed color does not.
Q: On an Android 11 phone, dynamic color is on. What colors does the app use?
A: The fallback `LightColors` or `DarkColors`. Dynamic schemes need API 31, so the `Build.VERSION` check falls through.
Q: Interview: How does `Text` inside a `Surface(color = primary)` know to use `onPrimary`?
A: `Surface` provides `LocalContentColor` set to the content color that matches its background. `Text` reads `LocalContentColor` when no color is passed, so it picks `onPrimary`.
:::

## Navigation and ViewModel integration

How screens get their ViewModels, collect state safely, and navigate with type-safe routes.

:::tldr
- Split each screen into a Route (gets the ViewModel, collects state) and a stateless Screen.
- Collect flows with `collectAsStateWithLifecycle()`, which stops work when the app is in the background.
- Navigation Compose uses `@Serializable` route types; pass IDs and lambdas, never the `NavController` or whole objects.
:::

### Route and Screen split

```kotlin
@Composable
fun ProfileRoute(viewModel: ProfileViewModel = hiltViewModel()) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    ProfileScreen(uiState = uiState, onRetry = viewModel::retry)
}

@Composable
fun ProfileScreen(uiState: ProfileUiState, onRetry: () -> Unit) { /* stateless */ }
```

- The **Route** knows about the ViewModel and navigation.
- The **Screen** only takes plain state and lambdas. Previews and UI tests target the Screen.
- Never pass the ViewModel down to child composables.

### Getting a ViewModel

- `viewModel()` comes from lifecycle-viewmodel-compose. `hiltViewModel()` does the same with Hilt injection.
- Both return a ViewModel scoped to the nearest `ViewModelStoreOwner`.
- Inside a `NavHost`, that owner is the **back stack entry**. Each destination gets its own ViewModel, cleared when the entry is popped.

> **Note:** In recent Hilt versions `hiltViewModel()` lives in the `hilt-lifecycle-viewmodel-compose` artifact; the older `hilt-navigation-compose` one still works.

### collectAsStateWithLifecycle

```kotlin
val uiState by viewModel.uiState.collectAsStateWithLifecycle()
```

It comes from lifecycle-runtime-compose. It collects only while the lifecycle is at least `STARTED`. When the app goes to the background, collection stops, so upstream work like location updates can stop too.

`collectAsState()` keeps collecting as long as the composable is in the composition, even in the background. On Android, prefer the lifecycle-aware version.

### Type-safe Navigation Compose

Since Navigation 2.8, routes are `@Serializable` types instead of strings.

```kotlin
@Serializable object Home
@Serializable data class Profile(val userId: String)

@Composable
fun AppNavHost(navController: NavHostController = rememberNavController()) {
    NavHost(navController, startDestination = Home) {
        composable<Home> {
            HomeScreen(onOpenProfile = { id -> navController.navigate(Profile(id)) })
        }
        composable<Profile> { backStackEntry ->
            val route: Profile = backStackEntry.toRoute()
            ProfileRoute(userId = route.userId)
        }
    }
}
```

- In the ViewModel, read arguments with `savedStateHandle.toRoute<Profile>()`.
- Pass **IDs**, not whole objects. The destination loads data from the repository.
- Do not pass `navController` deep into screens. Pass lambdas like `onOpenProfile`.

### Controlling the back stack

```kotlin
navController.navigate(Home) {
    popUpTo<Home> { inclusive = false }
    launchSingleTop = true
}
```

- `popUpTo` removes destinations above the target.
- `launchSingleTop` avoids a duplicate copy of the destination on top.
- For bottom navigation, combine `popUpTo(startDestination) { saveState = true }` with `restoreState = true` so each tab keeps its own stack.

### One-time events

Navigation after a save, or a snackbar, is an event, not state. A common approach is to model it as state the UI clears after handling it:

```kotlin
LaunchedEffect(uiState.savedId) {
    uiState.savedId?.let { id ->
        onSaved(id)
        viewModel.onSavedHandled()
    }
}
```

Another common choice is a `Channel` exposed as a `Flow` and collected in a `LaunchedEffect`. Either way, the ViewModel never holds a `NavController`.

> **Note:** Navigation 3 is a newer, separate library where you own the back stack as a plain list of keys. Know it exists; Navigation Compose with type-safe routes is still the common interview baseline.

:::check
Q: A screen uses `collectAsState()` on a flow that streams GPS updates. The user presses Home. What keeps happening, and what fixes it?
A: Collection continues in the background, so the GPS flow stays active and drains battery. Use `collectAsStateWithLifecycle()` so collection stops below `STARTED`.
Q: Why pass `userId` to the Profile route instead of the whole `User` object?
A: Routes are saved in the back stack and restored after process death, so they must be small and serializable. Passing an ID also keeps one source of truth: the destination loads fresh data.
Q: Interview: Why split a screen into a Route and a Screen composable?
A: The Route handles the ViewModel, state collection and navigation. The Screen is stateless, so it can be previewed and UI-tested with fake state and lambdas, with no ViewModel or DI.
:::

## Animations and gestures

Which animation API to pick for each job, how interruptions work, and how to handle touch input.

:::tldr
- Pick the highest-level API that fits: `animate*AsState`, `AnimatedVisibility`, `AnimatedContent`, then `updateTransition` and `Animatable`.
- `spring` is the default spec and handles interruptions smoothly; read animated values late, in `graphicsLayer {}`.
- Prefer high-level gesture modifiers like `clickable`; use `pointerInput` for custom gestures and key it correctly.
:::

### Choosing an animation API

| Need | API |
|---|---|
| Animate a single value when state changes | `animateFloatAsState`, `animateDpAsState`, `animateColorAsState` |
| Show or hide content | `AnimatedVisibility` |
| Switch between different content | `AnimatedContent`, `Crossfade` |
| Animate size changes | `Modifier.animateContentSize()` |
| Several values tied to one state | `updateTransition` |
| Manual control, gestures, interruptions | `Animatable` |
| Repeat forever | `rememberInfiniteTransition` |

### Value and visibility animations

```kotlin
val alpha by animateFloatAsState(if (enabled) 1f else 0.4f, label = "alpha")
Box(Modifier.graphicsLayer { this.alpha = alpha }) { /* ... */ }

AnimatedVisibility(
    visible = showDetails,
    enter = fadeIn() + expandVertically(),
    exit = fadeOut() + shrinkVertically()
) { DetailsPanel() }

AnimatedContent(targetState = count, label = "count") { target ->
    Text("$target")
}
```

`animate*AsState` is "fire and forget". You change the target, and the value animates there. If the target changes mid-animation, it smoothly retargets.

### Several values together

```kotlin
val transition = updateTransition(targetState = expanded, label = "card")
val elevation by transition.animateDp(label = "elevation") { if (it) 8.dp else 1.dp }
val corner by transition.animateDp(label = "corner") { if (it) 0.dp else 16.dp }
```

All values in one transition start and finish together, and the Animation Preview can inspect them as a group.

### Animatable for full control

```kotlin
val offsetX = remember { Animatable(0f) }
LaunchedEffect(shake) {
    if (shake) {
        offsetX.animateTo(0f, keyframes {
            durationMillis = 300; -20f at 50; 20f at 150; 0f at 300
        })
    }
}
```

- `animateTo` is a suspend function. Calling it again cancels the running animation and continues from the current value and velocity.
- `snapTo` jumps without animation. Use it while a finger drags.

### Animation specs

- `spring()` is the default for most APIs. It is physics-based and handles interruptions smoothly.
- `tween(durationMillis, easing = FastOutSlowInEasing)` for a fixed duration.
- `keyframes { }` for exact values at exact times.
- `repeatable` and `infiniteRepeatable` for repetition.

> **Tip:** Always set `label`. It names the animation in Android Studio's Animation Preview and in tooling.

Combine animation with late reads: animate a value, then read it inside `graphicsLayer {}` or `offset {}`. The animation then runs without recomposing every frame.

### Gestures

High-level modifiers cover most cases:

- `Modifier.clickable`, `combinedClickable` (long click, double click), `toggleable`, `selectable`.
- `Modifier.verticalScroll(rememberScrollState())` and `horizontalScroll`.
- `Modifier.draggable(rememberDraggableState { delta -> })` for one axis.
- `Modifier.transformable(rememberTransformableState { zoom, pan, rotation -> })` for pinch and rotate.
- `Modifier.anchoredDraggable` for snapping between anchors, like swipe-to-dismiss.

For custom gestures, use `pointerInput`:

```kotlin
Modifier.pointerInput(Unit) {
    detectTapGestures(
        onDoubleTap = { offset -> onDoubleTap(offset) },
        onLongPress = { onLongPress() }
    )
}
```

Other detectors include `detectDragGestures`, `detectTransformGestures` and `detectHorizontalDragGestures`.

> **Pitfall:** The `pointerInput` block restarts only when its key changes. If it captures a value that changes, pass that value as a key or read it through `rememberUpdatedState`. Otherwise the gesture uses a stale value.

> **Tip:** Prefer `clickable` over `pointerInput { detectTapGestures }` for simple clicks. `clickable` also gives ripple, focus and accessibility semantics.

:::deeper Shared elements
`SharedTransitionLayout` with `Modifier.sharedElement` and `Modifier.sharedBounds` animates an element between two screens, like a thumbnail growing into a detail image. Each side needs a matching key from `rememberSharedContentState(key)` and an `AnimatedVisibilityScope`, which `AnimatedContent` and Navigation Compose destinations provide.
:::

:::check
Q: A user taps a toggle twice quickly. With `animateFloatAsState` and the default spec, what does the animation do?
A: It retargets from the current value and velocity, because `spring` handles interruption smoothly. It does not jump back to the start.
Q: `Modifier.pointerInput(Unit) { detectTapGestures { onTap(item) } }` is used in a list row whose `item` changes. What bug appears?
A: The block never restarts, so it keeps the first `item` and taps report the wrong data. Use `pointerInput(item)` or `rememberUpdatedState(item)`.
Q: Interview: When would you use `Animatable` instead of `animateFloatAsState`?
A: When you need direct control: starting from a gesture, snapping with `snapTo`, chaining sequences in a coroutine, or reading velocity. `animateFloatAsState` only animates toward a target driven by state.
:::

## Interop and testing

How Compose and Views live together during migration, and how to test Compose UI through the semantics tree.

:::tldr
- `AndroidView` puts a View inside Compose; `ComposeView` puts Compose inside a View or Fragment.
- In Fragments, use `DisposeOnViewTreeLifecycleDestroyed` so the composition follows the view lifecycle.
- UI tests find nodes through the semantics tree, and the test rule waits for Compose to be idle for you.
:::

### Views inside Compose: AndroidView

```kotlin
@Composable
fun MapContainer(location: LatLng, modifier: Modifier = Modifier) {
    AndroidView(
        modifier = modifier,
        factory = { context -> MapView(context) },
        update = { view -> view.moveTo(location) }
    )
}
```

- `factory` runs once to create the View.
- `update` runs after creation and again whenever state it reads changes.
- `onRelease` cleans up when the view leaves. `onReset` prepares it for reuse in lazy lists.
- For XML layouts with View Binding, use `AndroidViewBinding`.

### Compose inside Views: ComposeView

```kotlin
override fun onCreateView(inflater: LayoutInflater, c: ViewGroup?, s: Bundle?): View =
    ComposeView(requireContext()).apply {
        setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
        setContent { AppTheme { ProfileScreen() } }
    }
```

A Fragment's view can be destroyed while the Fragment lives on the back stack. `DisposeOnViewTreeLifecycleDestroyed` ties the composition to the view's lifecycle, so it is disposed with the view.

> **Tip:** Migrate screen by screen or bottom up. Build a Compose theme that matches the existing View theme, so both worlds look the same during migration.

### The semantics tree

Compose UI tests work on the **semantics tree**. It is a parallel tree that describes meaning: text, role, content description, state. Accessibility services use the same tree.

That means good accessibility and good tests go together. A button with a clear label is easy for TalkBack and easy to find in a test.

### A first UI test

```kotlin
class LoginScreenTest {
    @get:Rule val composeTestRule = createComposeRule()

    @Test
    fun showsErrorOnEmptySubmit() {
        composeTestRule.setContent {
            AppTheme { LoginScreen(state = LoginUiState(), onSubmit = {}) }
        }
        composeTestRule.onNodeWithText("Log in").performClick()
        composeTestRule.onNodeWithText("Email is required").assertIsDisplayed()
    }
}
```

- **Rules:** `createComposeRule()` tests composables alone. `createAndroidComposeRule<MainActivity>()` is for when you need a real Activity.
- **Finders:** `onNodeWithText`, `onNodeWithContentDescription`, `onNodeWithTag`, `onAllNodesWithText`, `onNode(hasText("x") and hasClickAction())`.
- **Actions:** `performClick`, `performTextInput`, `performScrollTo`, `performTouchInput { swipeLeft() }`.
- **Assertions:** `assertIsDisplayed`, `assertExists`, `assertDoesNotExist`, `assertTextEquals`, `assertIsEnabled`.
- Add `Modifier.testTag("error")` to nodes without unique text.

### Merged semantics

Some nodes **merge** their children's semantics. A `Button` merges its inner `Text`, so the button node itself has the text.

- Finders search the merged tree by default.
- Pass `useUnmergedTree = true` to reach children.
- Print the tree to debug: `composeTestRule.onRoot().printToLog("TAG")`.

### Synchronization and time

The test rule is synchronized with Compose. Before each finder or assertion it waits until recomposition, layout and animations are idle. You do not add sleeps.

- Take control of time with `composeTestRule.mainClock.autoAdvance = false` and `mainClock.advanceTimeBy(500)`.
- For async work outside Compose, use `composeTestRule.waitUntil { condition }`.

### What to test where

| Layer | How |
|---|---|
| ViewModel and logic | Plain JVM unit tests |
| Stateless Screen | Compose UI test with fake state |
| Look and layout | Screenshot tests (Compose Preview Screenshot Testing, Paparazzi, Roborazzi) |
| Full flows | A few end-to-end tests with a real Activity |

> **Tip:** Test the stateless Screen with fake state and record events in lambdas. That covers most UI behavior without DI or a network.

:::check
Q: `onNodeWithText("Submit").assertExists()` passes, but `onNodeWithTag("label")` fails for the `Text` inside the same `Button`. Why?
A: The `Button` merges its children's semantics, so the inner `Text` node is hidden in the merged tree. Use `useUnmergedTree = true`.
Q: A Fragment uses `ComposeView` with the default strategy and is replaced and added to the back stack. What risk does `DisposeOnViewTreeLifecycleDestroyed` remove?
A: The composition is disposed when the Fragment's view is destroyed, not later. This avoids keeping a composition, and anything it holds, alive while only the Fragment object remains.
Q: Interview: How do Compose UI tests find elements, and why do you not need sleeps?
A: They match properties in the semantics tree with finders like `onNodeWithText` and `onNodeWithTag`. The test rule waits for Compose to be idle before each action and assertion, so recomposition and animations are already done.
:::

## Performance and tooling

How to find and fix slow Compose UI, the tools that show you what is happening, and a checklist to apply.

:::tldr
- Always measure in a release build with R8 and a Baseline Profile before you optimize.
- Layout Inspector shows recomposition and skip counts; compiler reports show stability and skippability.
- Most fixes are the same few: defer reads, remember work, avoid new instances, add keys, use `derivedStateOf`.
:::

### Measure the right build

Debug builds of Compose are much slower than release builds. Debug adds checks, has no R8 optimizations, and runs code interpreted. A screen that stutters in debug may be smooth in release.

So the first step is always: build release with R8, install with a Baseline Profile, then measure.

### Baseline Profiles

Compose is a library shipped inside your APK, not part of the OS. Its code is not precompiled on the device, so it starts out interpreted and JIT compiled. That slows startup and the first scrolls.

A **Baseline Profile** lists the hot classes and methods. They are compiled ahead of time when the app installs. This improves startup and early frame smoothness.

- Generate one with the Baseline Profile Gradle plugin and a Macrobenchmark module.
- Cover critical user journeys: startup, main feed scroll, opening a detail screen.
- Compose libraries ship their own profiles, but your own code needs yours.

### Layout Inspector

Layout Inspector in Android Studio shows the composable tree and each composable's parameters. It can also show **recomposition counts and skip counts**.

A count that climbs fast while nothing visible changes is a red flag. A high skip count is good: it means Compose checked the composable and skipped it.

### Compose compiler reports

Compiler reports show which composables are restartable and skippable, and which parameters are stable or unstable.

```kotlin
// module build.gradle.kts
composeCompiler {
    reportsDestination = layout.buildDirectory.dir("compose_compiler")
    metricsDestination = layout.buildDirectory.dir("compose_compiler")
}
```

Build a release variant, then open the `-composables.txt` file. Look for `unstable` parameters on composables that recompose too often.

### Tracing and benchmarks

- **Composition tracing:** with the runtime tracing dependency, composable names appear in system traces in Perfetto and the Android Studio profiler.
- **Macrobenchmark:** measures startup and frame timing (jank) on a real device in release mode. Use it to prove a fix helped.

### Performance checklist

1. Measure in a **release build** with R8 and a Baseline Profile.
2. Use Layout Inspector counts to find hot spots.
3. Read fast-changing state (scroll, animation) in **layout or draw** with lambda modifiers.
4. Use `derivedStateOf` for results that change less often than their input.
5. Wrap expensive calculations in `remember(keys)`, or move them to the ViewModel.
6. Do not create new lists or objects in composition and pass them to children.
7. Give lazy items `key` and `contentType`.
8. Never write state that was already read in the same composition.
9. Keep composables small so recomposition scopes stay small.
10. Avoid needless `SubcomposeLayout` and `BoxWithConstraints`.
11. Use `collectAsStateWithLifecycle` so hidden screens stop working.
12. Check stability with compiler reports when something recomposes more than expected.

### Common pitfalls

- Forgetting `remember`: `val state = mutableStateOf(0)` resets on every recomposition. Lint warns about this.
- Side effects in the body: network calls, analytics or `viewModel.load()` directly in a composable.
- Wrong effect keys: `LaunchedEffect(Unit)` reading a parameter that changes.
- Passing a ViewModel or `NavController` deep into the tree.
- Lying with `@Immutable` or `@Stable`: the UI stops updating.
- Measuring performance in debug builds and drawing wrong conclusions.

> **Interview:** "How would you debug a screen that recomposes too much?" Release build first, Layout Inspector counts to find the hot composable, then look for high state reads, per-frame values read in composition, new instances per recomposition, and unstable types in compiler reports.

:::deeper Tooling for previews
- `@Preview` takes `uiMode`, `fontScale`, `device` and `widthDp`.
- Multipreview annotations like `@PreviewLightDark`, `@PreviewFontScale` and `@PreviewScreenSizes` render several variants at once.
- `@PreviewParameter` feeds sample data from a `PreviewParameterProvider`.
- Interactive preview and Animation Preview let you click and scrub animations without running the app.
:::

:::check
Q: A teammate says a list is janky and shares a trace from a debug build. What is your first response?
A: Re-measure in a release build with R8 and a Baseline Profile. Debug Compose is much slower, so the trace may show problems that do not exist in production.
Q: Layout Inspector shows a row with a high recomposition count and zero skips, while the data looks unchanged. What do you check?
A: Whether its parameters are new instances on each recomposition (like a list built with `map` in the parent) or unstable types compared by `===`. Then remember the value or move the work to the ViewModel.
Q: Interview: What are Baseline Profiles and why do they matter more for Compose?
A: A list of hot code to compile ahead of time at install. Compose ships in your APK rather than the OS, so without a profile its code runs interpreted or JIT at first, which slows startup and early frames.
:::

## Review and cheat sheet

One screen of everything in this topic, plus practice to lock it in.

:::tldr
- Skim the cheat sheet the night before an interview; each row maps to an earlier lesson.
- Do the five exercises: each one forces you to see recomposition, not just read about it.
- When unsure why something recomposes, open Layout Inspector before you guess.
:::

### Cheat sheet

| Topic | Remember |
|---|---|
| Mental model | UI = f(state); state down, events up |
| Composable rules | Fast, idempotent, side-effect free, may skip, any order |
| Phases | Composition, layout, draw; read state as late as possible |
| Late reads | `offset {}`, `graphicsLayer {}`, `drawBehind {}`, `layout {}` |
| State | `remember { mutableStateOf() }`; primitives use `mutableIntStateOf` |
| Survive rotation | `rememberSaveable` (with a Saver) or ViewModel |
| Slower result | `remember { derivedStateOf { } }` |
| Lists in state | `mutableStateListOf` or replace an immutable List |
| Hoisting | `value` plus `onValueChange`; lowest common ancestor |
| Stability | Strong skipping default since Kotlin 2.0.20; unstable params use `===` |
| Suspend work on key change | `LaunchedEffect(key)` |
| Cleanup | `DisposableEffect` with `onDispose` |
| Coroutine from click | `rememberCoroutineScope` |
| Newest value in long effect | `rememberUpdatedState` |
| State to Flow | `snapshotFlow {}` inside `LaunchedEffect` |
| CompositionLocal | Static for rarely changing; prefer explicit params |
| Modifiers | Outside in; apply `modifier` first on the root |
| Custom modifier | Chain existing, else `Modifier.Node`, not `composed` |
| Layout | Measure each child once; intrinsics or SubcomposeLayout when needed |
| Lazy lists | `key`, `contentType`, no unbounded nested scroll |
| Theming | Color roles, light and dark schemes, dynamic color on API 31+ |
| ViewModel | Route plus stateless Screen; `collectAsStateWithLifecycle` |
| Navigation | `@Serializable` routes, `toRoute()`, pass IDs and lambdas |
| Animation | `animate*AsState` first; `Animatable` for control; spring default |
| Gestures | `clickable` first; key `pointerInput` correctly |
| Interop | `AndroidView` and `ComposeView`; Fragment strategy |
| Testing | Semantics tree, `createComposeRule`, `useUnmergedTree` |
| Perf tools | Layout Inspector counts, compiler reports, Baseline Profiles, Macrobenchmark |

### The pitfalls that come up most

- Missing `remember`, or `remember` where `rememberSaveable` was needed.
- Changing a `MutableList` in place inside `mutableStateOf`.
- Writing state in the composition body (backwards write).
- `LaunchedEffect(Unit)` reading a parameter that changes.
- Lazy lists without keys, or keys built from content hashes.
- Reading scroll or animation values in composition.
- New lists built in composition and passed to children.
- `LazyColumn` inside a vertically scrolling `Column`.

### Practice exercises

1. **Scroll-aware header.** Build a `LazyColumn` with a header image that moves at half the scroll speed and fades out. Use `Modifier.graphicsLayer {}` so Layout Inspector shows zero recompositions while scrolling. Add a "scroll to top" FAB driven by `derivedStateOf`.
2. **Hoisted form.** Build a sign-up form with name, email and password fields. Make every field stateless. Put validation in a ViewModel exposing `StateFlow<SignUpUiState>`. Write a Compose UI test that types an invalid email and checks the error text.
3. **Custom layout.** Implement a `FlowTags` layout with `Layout` that places chips left to right and wraps to a new line. Respect constraints and RTL with `placeRelative`. Then compare it with the built-in `FlowRow`.
4. **Effects drill.** Write a composable that runs a 5-second countdown, calls `onFinished` at the end, restarts when `sessionId` changes, and uses the latest `onFinished` without restarting. Add a `DisposableEffect` that logs when the screen leaves.
5. **Recomposition hunt.** Take a list screen that filters a `List<Item>` in the composable body and animates a background with `Modifier.background`. Turn on compiler reports and Layout Inspector counts, explain each problem, and fix both.

### References

- [Thinking in Compose](https://developer.android.com/develop/ui/compose/mental-model)
- [Compose phases](https://developer.android.com/develop/ui/compose/phases)
- [State and Jetpack Compose](https://developer.android.com/develop/ui/compose/state)
- [Where to hoist state](https://developer.android.com/develop/ui/compose/state-hoisting)
- [Side effects in Compose](https://developer.android.com/develop/ui/compose/side-effects)
- [Stability in Compose](https://developer.android.com/develop/ui/compose/performance/stability)
- [Strong skipping mode](https://developer.android.com/develop/ui/compose/performance/stability/strongskipping)
- [Compose performance best practices](https://developer.android.com/develop/ui/compose/performance/bestpractices)
- [CompositionLocal](https://developer.android.com/develop/ui/compose/compositionlocal)
- [Modifiers](https://developer.android.com/develop/ui/compose/modifiers)
- [Custom modifiers](https://developer.android.com/develop/ui/compose/custom-modifiers)
- [Custom layouts](https://developer.android.com/develop/ui/compose/layouts/custom)
- [Lists and grids](https://developer.android.com/develop/ui/compose/lists)
- [Material 3 in Compose](https://developer.android.com/develop/ui/compose/designsystems/material3)
- [Type-safe navigation](https://developer.android.com/guide/navigation/design/type-safety)
- [Animations](https://developer.android.com/develop/ui/compose/animation/introduction)
- [Gestures](https://developer.android.com/develop/ui/compose/touch-input/pointer-input)
- [Interoperability APIs](https://developer.android.com/develop/ui/compose/migrate/interoperability-apis)
- [Testing your Compose layout](https://developer.android.com/develop/ui/compose/testing)
- [Compose compiler reports](https://developer.android.com/develop/ui/compose/performance/stability/diagnose)
- [Baseline Profiles](https://developer.android.com/topic/performance/baselineprofiles/overview)
- [Compose API guidelines](https://android.googlesource.com/platform/frameworks/support/+/androidx-main/compose/docs/compose-api-guidelines.md)

:::check
Q: A screen shows a scroll-to-top button with `if (listState.firstVisibleItemIndex > 0)` read directly in the screen composable. Name the problem and the fix.
A: The index changes on every scroll step, so the whole screen recomposes while scrolling. Wrap it in `remember { derivedStateOf { listState.firstVisibleItemIndex > 0 } }`.
Q: Spot the bug: `LaunchedEffect(Unit) { delay(3000); onDone() }` where the parent passes a new `onDone` lambda after one second.
A: The effect calls the old `onDone` it captured at launch. Wrap it with `val current by rememberUpdatedState(onDone)` and call `current()`.
Q: Interview: Walk through what happens, phase by phase, when a user taps a button that increments a counter shown in a `Text`.
A: The click writes a `MutableState`. Compose schedules recomposition of the scope that read it, re-runs that composable and skips unchanged children. The new text may change size, so layout re-measures and places it, then the draw phase paints the new frame.
:::
