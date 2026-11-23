Jetpack Compose is Android's modern, declarative UI toolkit. You describe what the screen should look like for a given state, and Compose keeps the screen in sync when that state changes. These notes focus on what a senior engineer needs day to day: correct mental models, state and side effects, layouts, performance, testing, and the questions interviewers actually ask.

## Mental Model

### Declarative UI in one sentence

In the View system you build a tree of objects and then mutate them (`textView.text = "Hi"`). In Compose you write functions that turn state into UI. When state changes, Compose calls the affected functions again and updates only what changed.

The core idea is `UI = f(state)`. You do not hold references to widgets. You do not call setters. You change state, and the UI follows.

```kotlin
@Composable
fun Greeting(name: String) {
    Text(text = "Hello, $name")
}
```

There is no `TextView` object you keep around. If `name` changes, the caller calls `Greeting` again with the new value. This re-run is called **recomposition**.

### What @Composable really means

The `@Composable` annotation tells the Compose compiler plugin to transform the function. The compiler adds hidden parameters (a `Composer` and some bit flags). That lets the runtime remember values across calls, track which state each function reads, and skip functions whose inputs did not change.

Because of this transform, composable functions can only be called from other composable functions (or from entry points like `setContent`).

- Composables return `Unit` when they emit UI. By convention their names are nouns in PascalCase (`ProfileCard`).
- Composables that return a value (like `remember`) use camelCase and do not emit UI.
- Composables have no lifecycle callbacks of their own. They enter the composition, recompose zero or more times, and leave the composition.

### The rules you must follow

Compose makes few guarantees about when and how often your function runs. Write every composable as if:

1. **It can run very often.** Possibly every frame during an animation. Keep it cheap. No disk or network work in the body.
2. **It can be skipped.** If its inputs did not change, Compose may not call it at all.
3. **It can run in any order.** Do not assume siblings run top to bottom and share state through globals.
4. **It should be idempotent.** Same inputs, same UI.
5. **It must be free of side effects in its body.** Writing to a non-Compose variable, logging analytics, or starting a request directly in the body is a bug. Use the side-effect APIs instead.

```kotlin
// BAD: side effect in the composition body
@Composable
fun Counter(items: List<Item>) {
    var count = 0
    Column {
        items.forEach { count++; Text(it.name) } // runs again on every recomposition
        Text("Count: $count")
    }
}
```

> **Interview:** "Composables must be side-effect free" means the function body only describes UI; anything that touches the outside world goes into LaunchedEffect, DisposableEffect, SideEffect, or an event callback.

### Composition, recomposition, and identity

The first time Compose runs your UI tree, it builds the **composition**: a record of which composables were called and what they remembered. On later changes it re-runs only the parts that read changed state.

Compose identifies each call by its **position in the source code** (the call site) plus the order of calls. Inside loops, position alone is not enough, which is why `key {}` exists (covered later).

> **Under the hood:** The composition is stored in a structure called the slot table, and state changes are tracked by the snapshot system. You only need working knowledge here; the internals are a later topic.

## The Three Phases

Every frame, Compose can run up to three phases in order:

| Phase | Question it answers | Typical work |
|---|---|---|
| Composition | What UI to show? | Runs composable functions, builds or updates the UI tree |
| Layout | Where to place it? | Measures children, decides sizes, places them |
| Drawing | How does it render? | Draws pixels into a canvas |

Data flows one way: composition, then layout, then drawing. Layout itself has two steps: **measure** and **place**.

### Why phases matter for performance

Compose tracks **where** a state value is read. When the state changes, Compose only re-runs the phase that read it, and the phases after it.

- State read in a composable body: change triggers composition, layout, and draw.
- State read in a layout or placement block: change triggers layout and draw only.
- State read in a draw block: change triggers draw only.

So the rule is: **read fast-changing state as late as possible**.

### Deferring reads with lambda modifiers

Many modifiers have two versions: one that takes a value, and one that takes a lambda. The lambda version reads state later.

```kotlin
// Reads scroll in composition: recomposes on every scroll pixel
Box(Modifier.offset(y = (scrollState.value / 2).dp))

// Reads scroll in the placement step: no recomposition
Box(Modifier.offset { IntOffset(0, scrollState.value / 2) })
```

Common late-reading modifiers:

- `Modifier.offset { }` reads during placement (layout phase).
- `Modifier.graphicsLayer { alpha = ...; translationX = ...; scaleX = ... }` reads during the draw/layer phase.
- `Modifier.drawBehind { }` and `Modifier.drawWithContent { }` read during drawing.
- `Modifier.layout { measurable, constraints -> }` reads during layout.

```kotlin
@Composable
fun PulsingBox() {
    val color by rememberInfiniteTransition(label = "pulse").animateColor(
        initialValue = Color.Red, targetValue = Color.Blue,
        animationSpec = infiniteRepeatable(tween(1000), RepeatMode.Reverse),
        label = "color"
    )
    // Modifier.background(color) would recompose every frame.
    Box(Modifier.size(64.dp).drawBehind { drawRect(color) })
}
```

> **Tip:** Pass a lambda like `() -> Int` instead of an `Int` when a child only needs a value at layout or draw time. The parent then stops reading the state in composition.

## State and Recomposition

### What triggers recomposition

Recomposition happens when a **Compose `State` object** that was read during composition is written to. Plain Kotlin variables do not trigger anything. A `MutableList` that you mutate in place does not trigger anything.

Recomposition is **scoped**. Compose re-runs the smallest restartable scope that read the state (usually the nearest non-inline composable function), not the whole screen.

> **Note:** `Column`, `Row`, and `Box` are inline functions, so they do not create their own recomposition scope. A state read inside a `Column` body recomposes the enclosing composable function.

### mutableStateOf and remember

```kotlin
@Composable
fun Counter() {
    var count by remember { mutableStateOf(0) }
    Button(onClick = { count++ }) {
        Text("Clicked $count times")
    }
}
```

- `mutableStateOf(x)` creates an observable `MutableState<T>`.
- `remember { }` stores the value in the composition so it survives recomposition. Without `remember`, the state would reset to 0 on every recomposition.
- `remember(key1) { }` recalculates when `key1` changes.
- Use specialized versions for primitives: `mutableIntStateOf`, `mutableFloatStateOf`, `mutableLongStateOf`, `mutableDoubleStateOf`. They avoid boxing.

`remember` survives recomposition but **not** configuration changes or process death. It is also forgotten when the composable leaves the composition.

### rememberSaveable and Saver

`rememberSaveable` stores the value in the saved instance state `Bundle`. It survives rotation and process death (and back stack restoration in Navigation).

```kotlin
var query by rememberSaveable { mutableStateOf("") }
```

It works out of the box for types that fit in a `Bundle` (primitives, `String`, `Parcelable`). For other types, provide a `Saver`.

```kotlin
data class City(val name: String, val country: String)

val CitySaver = listSaver<City, Any>(
    save = { listOf(it.name, it.country) },
    restore = { City(it[0] as String, it[1] as String) }
)

@Composable
fun CityScreen() {
    var city by rememberSaveable(stateSaver = CitySaver) {
        mutableStateOf(City("Madrid", "Spain"))
    }
}
```

Options: `@Parcelize` the class, `mapSaver`, `listSaver`, or a custom `Saver(save, restore)`.

> **Pitfall:** Do not put large objects in `rememberSaveable`. The Bundle has a size limit, and a `TransactionTooLargeException` can crash the app. Save IDs, not data.

### derivedStateOf

Use `derivedStateOf` when a state changes **more often** than the result you need from it. It only notifies readers when the computed result actually changes.

```kotlin
val listState = rememberLazyListState()
val showScrollToTop by remember {
    derivedStateOf { listState.firstVisibleItemIndex > 0 }
}
```

The index changes on every scroll step, but the boolean changes rarely. Without `derivedStateOf`, every scroll step would recompose the reader.

> **Pitfall:** Do not use `derivedStateOf` when output changes as often as input, like `"$firstName $lastName"`. That just adds overhead. Plain computation or `remember(firstName, lastName)` is fine.

### snapshotFlow

`snapshotFlow` turns Compose state reads into a cold Kotlin `Flow`. It emits when the read state changes (and the new value is not equal to the last emitted one).

```kotlin
LaunchedEffect(listState) {
    snapshotFlow { listState.firstVisibleItemIndex }
        .filter { it > 10 }
        .distinctUntilChanged()
        .collect { analytics.logScrolledDeep() }
}
```

Use it to bridge Compose state to coroutine-based logic: analytics, saving drafts, debounced search.

### Observable collections

```kotlin
val todos = remember { mutableStateListOf<Todo>() }
todos.add(Todo("Buy milk"))  // triggers recomposition of readers
```

- `mutableStateListOf` and `mutableStateMapOf` are observable.
- `mutableStateOf(mutableListOf())` plus `list.add()` does **not** trigger recomposition, because the `State` reference never changes.
- In ViewModels, prefer an immutable `List` inside a `StateFlow` and replace it: `_items.update { it + newItem }`.

### Other observable types

Compose can observe `Flow` (`collectAsState`, `collectAsStateWithLifecycle`), `LiveData` (`observeAsState`), and RxJava (`subscribeAsState`). All convert to `State<T>` so Compose can track reads.

## Hoisting and Data Flow

### Stateless vs stateful composables

A **stateful** composable owns its state with `remember`. A **stateless** composable receives state as parameters and reports events through lambdas.

```kotlin
// Stateless: easy to preview, test, and reuse
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

### State hoisting

**State hoisting** means moving state up to a caller so the child becomes stateless. The pattern is to replace a state variable with two parameters:

- `value: T` — the current value to show.
- `onValueChange: (T) -> Unit` — an event asking to change it.

Hoist state to the **lowest common ancestor** of all composables that read or write it. Do not hoist higher than needed.

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

Benefits: a single source of truth, predictable updates, and easy testing because UI is a pure function of state.

### Where state should live

| Kind of state | Where it lives |
|---|---|
| Simple UI element state (expanded, focus) | `remember` in the composable |
| UI state that must survive rotation | `rememberSaveable` |
| Complex UI logic (several related states) | A plain state holder class, created with `remember` |
| Screen state from business logic | `ViewModel` exposing `StateFlow` |

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

> **Tip:** Follow the API conventions: `modifier: Modifier = Modifier` as the first optional parameter, applied to the root element of the composable, and never shared with children.

## Stability and Skipping

### What skipping means

When a parent recomposes, Compose decides for each child call: can I skip it? It skips if the child is **skippable** and all arguments are equal to the previous ones.

### Stable types, in working terms

A type is **stable** if Compose can trust that equal values mean equal UI, and that any change to it will be noticed. In practice:

- Primitives, `String`, and function types are stable.
- A class with only `val` properties of stable types is stable (inferred by the compiler).
- A class with any `var` that is not a `State` is unstable.
- Standard `List`, `Set`, `Map` are **unstable**, because the interface could be backed by a mutable implementation.
- Classes from modules not compiled with the Compose compiler are treated as unstable unless you configure them.

### @Immutable and @Stable

- `@Immutable` promises that all public properties never change after construction.
- `@Stable` promises that `equals` is consistent and that any public property change is observable by Compose (usually because it is backed by `mutableStateOf`).

These are **promises**. The compiler does not verify them. Lying leads to UI that does not update.

```kotlin
@Immutable
data class ProfileUi(val name: String, val tags: List<String>)
```

### Handling collections

Three common approaches:

1. Use `ImmutableList` / `PersistentList` from `kotlinx.collections.immutable`. The compiler treats them as stable.
2. Wrap the list in an `@Immutable` class.
3. Add the types to a **stability configuration file** in the Compose compiler Gradle settings (for example `kotlin.collections.List` or your domain module classes).

### Strong skipping mode

Since Kotlin 2.0.20, **strong skipping mode is on by default**. It changes the rules in two important ways:

- **All restartable composables become skippable**, even with unstable parameters.
  - Unstable parameters are compared with **instance equality** (`===`).
  - Stable parameters are still compared with `equals()`.
- **Lambdas are remembered automatically**, including lambdas that capture unstable values (keyed on the captured values).

So stability still matters, but it matters less. An unstable `List` that is the **same instance** will be skipped. A new list instance with the same contents (for example rebuilt by `map` in every recomposition) will not.

```kotlin
@Composable
fun Screen(users: List<User>) {
    // New list instance every recomposition: UserList cannot skip
    UserList(users.filter { it.active })

    // Stable instance across recompositions: UserList can skip
    val active = remember(users) { users.filter { it.active } }
    UserList(active)
}
```

> **Interview:** With strong skipping, "make everything stable" is no longer the default advice. The focus moves to avoiding new instances each recomposition and reading state in the right phase.

> **Tip:** Use `@NonRestartableComposable` or `@NonSkippableComposable` only in rare cases. If you see them often in code review, ask why.

### Lambdas and method references

Before strong skipping, passing `viewModel::onClick` or a lambda capturing an unstable value could break skipping. With strong skipping, the compiler wraps lambdas in `remember` for you. You rarely need to `remember` lambdas by hand now.

## Side Effects

A **side effect** is a change to the world outside the composable's scope. Composables should be side-effect free, so Compose gives you controlled APIs to run effects at the right time.

### LaunchedEffect

Runs a suspend block in a coroutine scoped to the composition. Cancels when it leaves the composition. Restarts (cancel then relaunch) when any key changes.

```kotlin
@Composable
fun SnackbarOnError(error: String?, snackbarHost: SnackbarHostState) {
    LaunchedEffect(error) {
        if (error != null) snackbarHost.showSnackbar(error)
    }
}
```

> **Pitfall:** `LaunchedEffect(Unit)` or `LaunchedEffect(true)` runs once per entry into the composition. Fine for one-time work, but if the block uses a changing value, either add it as a key or use `rememberUpdatedState`.

### DisposableEffect

For effects that need cleanup. The block must end with `onDispose { }`.

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

Use it for listeners, callbacks, broadcast receivers, sensors.

### SideEffect

Runs after **every successful recomposition**. Use it to publish Compose state to non-Compose code.

```kotlin
SideEffect {
    analytics.setUserProperty("theme", themeName)
}
```

### rememberCoroutineScope

Gives a `CoroutineScope` tied to the composition, for launching coroutines **from event callbacks** (not from the composition body).

```kotlin
val scope = rememberCoroutineScope()
Button(onClick = { scope.launch { drawerState.open() } }) { Text("Menu") }
```

### rememberUpdatedState

Captures the latest value inside a long-running effect **without restarting it**.

```kotlin
@Composable
fun SplashScreen(onTimeout: () -> Unit) {
    val currentOnTimeout by rememberUpdatedState(onTimeout)
    LaunchedEffect(Unit) {
        delay(2_000)
        currentOnTimeout() // latest lambda, timer not restarted
    }
}
```

### produceState

Converts non-Compose data sources into `State`. It launches a coroutine and you set `value`.

```kotlin
@Composable
fun loadImage(url: String, repo: ImageRepo): State<Result<Image>> =
    produceState<Result<Image>>(initialValue = Result.Loading, url) {
        value = repo.load(url)
    }
```

You can also use `awaitDispose { }` inside it to clean up callback-based sources.

### Decision table

| Need | Use |
|---|---|
| Run suspend work when a key changes | `LaunchedEffect(key)` |
| Register and unregister a listener | `DisposableEffect(key)` |
| Push Compose state to non-Compose code after each recomposition | `SideEffect` |
| Launch a coroutine from a click or other callback | `rememberCoroutineScope` |
| Use the newest lambda or value inside a long effect without restarting | `rememberUpdatedState` |
| Turn a callback or suspend source into State | `produceState` |
| Turn Compose state into a Flow | `snapshotFlow` |
| Compute a value that changes less often than its inputs | `derivedStateOf` |

> **Interview:** The keys of an effect are its restart triggers. Too few keys means stale values; too many means the effect restarts too often.

## CompositionLocal

### What it is

`CompositionLocal` passes data **implicitly** down the tree, without threading it through every parameter. Material uses it for `LocalContentColor`, and Android exposes `LocalContext`, `LocalLifecycleOwner`, `LocalDensity`, and `LocalConfiguration`.

```kotlin
data class Spacing(val small: Dp = 4.dp, val medium: Dp = 8.dp, val large: Dp = 16.dp)
val LocalSpacing = staticCompositionLocalOf { Spacing() }

@Composable
fun AppTheme(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalSpacing provides Spacing()) {
        MaterialTheme(content = content)
    }
}

// Reading:
val spacing = LocalSpacing.current
```

### Static vs dynamic

| API | When the value changes | Best for |
|---|---|---|
| `compositionLocalOf` | Only composables that read `.current` recompose | Values that may change often |
| `staticCompositionLocalOf` | The entire content of the provider recomposes | Values that almost never change (theme tokens, injected services) |

`staticCompositionLocalOf` is cheaper to read because Compose does not track individual readers.

### When to use it

- **Good:** cross-cutting, tree-scoped values with a sensible default: theme, spacing, image loader, locale-like settings.
- **Bad:** passing screen data or ViewModels deep into the tree. It hides dependencies, makes previews and tests harder, and breaks the "explicit inputs" model.

> **Pitfall:** Prefer explicit parameters. A good rule: if most composables in the tree do not need it, or it has no good default, do not make it a CompositionLocal.

## Modifiers

### Order matters

Modifiers are applied **in order, outside in**. Each modifier wraps everything after it. Changing the order changes the result.

```kotlin
// Padding is outside the background: blue box with transparent margin
Modifier.padding(16.dp).background(Color.Blue)

// Background is outside the padding: blue fills the padded area too
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

// Background first, then clip: background draws square corners
Modifier.background(Color.Blue).clip(RoundedCornerShape(12.dp))
```

For sizes, the first size constraint usually wins: `Modifier.size(100.dp).size(50.dp)` gives 100dp, because the outer modifier has already fixed the constraints. Use `requiredSize` to force a size against incoming constraints.

### Chaining and reuse

- Modifiers are immutable values. You can store them: `val cardModifier = Modifier.padding(8.dp).fillMaxWidth()`.
- Use `then` to combine: `modifier.then(Modifier.border(1.dp, Color.Gray))`.
- Conditional modifiers: `Modifier.then(if (selected) Modifier.border(2.dp, Color.Red) else Modifier)`.
- Always accept `modifier: Modifier = Modifier` and apply it **first** on the root: `Box(modifier.padding(8.dp))`.

### Scoped modifiers

Some modifiers only exist inside certain scopes: `Modifier.weight()` inside `RowScope`/`ColumnScope`, `Modifier.align()` inside `BoxScope`, `Modifier.animateItem()` inside `LazyItemScope`. This type-safety prevents misuse.

### Custom modifiers with Modifier.Node

There are three ways to build a custom modifier:

1. **Chain existing modifiers** in an extension function. Simplest, best default.
2. **`composed { }`** — the old way. Discouraged now because of performance cost.
3. **`Modifier.Node`** — the recommended low-level API. The built-in modifiers use it.

A `Modifier.Node` setup has two parts: a `ModifierNodeElement` (a cheap, data-class description that is compared across recompositions) and a `Modifier.Node` (a long-lived object that does the work).

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

- `create()` runs once when the modifier first appears.
- `update()` runs when the element is not equal to the previous one. The node is reused, not recreated.
- Nodes implement interfaces for what they do: `DrawModifierNode`, `LayoutModifierNode`, `PointerInputModifierNode`, `SemanticsModifierNode`, `CompositionLocalConsumerModifierNode`, and more.

> **Under the hood:** Modifier.Node avoids allocations on recomposition and lets each node invalidate only its own phase, which is why the built-in modifiers moved to it.

## Layouts

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

- **Arrangement** controls spacing along the main axis (`Start`, `Center`, `SpaceBetween`, `SpaceEvenly`, `spacedBy(8.dp)`).
- **Alignment** controls position on the cross axis.
- `Modifier.weight(1f)` shares the remaining space. Weighted children are measured after unweighted ones.
- `Box` stacks children. Use `Modifier.align(Alignment.BottomEnd)` on a child, or `contentAlignment` on the Box.
- `Spacer(Modifier.height(8.dp))` adds fixed gaps.

### ConstraintLayout

`ConstraintLayout` for Compose lives in a separate artifact (`constraintlayout-compose`). Use it for complex relative positioning, barriers, guidelines, and chains. In Compose, nested `Row`/`Column` are cheap (no double taxation like nested Views), so ConstraintLayout is a readability choice, not a performance requirement.

```kotlin
ConstraintLayout(Modifier.fillMaxWidth()) {
    val (avatar, name) = createRefs()
    Image(painter, null, Modifier.constrainAs(avatar) {
        start.linkTo(parent.start); top.linkTo(parent.top)
    })
    Text("Ada", Modifier.constrainAs(name) {
        start.linkTo(avatar.end, margin = 8.dp); centerVerticallyTo(avatar)
    })
}
```

### Constraints and the single-pass rule

Layout works top-down for constraints and bottom-up for sizes:

1. A parent passes **constraints** (min/max width and height) to each child.
2. Each child measures itself and returns a **size** within those constraints.
3. The parent decides the child's position and places it.

**Each child may be measured only once per layout pass.** Measuring a child twice throws an exception. This is what keeps Compose layout fast even with deep nesting: it is linear in the number of nodes.

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

For a single element, use `Modifier.layout { measurable, constraints -> }`.

`placeRelative` mirrors positions in right-to-left layouts. `place` does not.

### Intrinsic measurements

Sometimes a parent needs to know a child's size **before** measuring it, for example to make two items in a row match the tallest one. Intrinsics let you query a child's min or max intrinsic size without measuring it.

```kotlin
Row(Modifier.height(IntrinsicSize.Min)) {
    Text("Left", Modifier.weight(1f))
    VerticalDivider(Modifier.fillMaxHeight())
    Text("Right\nTwo lines", Modifier.weight(1f))
}
```

The divider fills the height of the tallest text instead of the whole screen.

### SubcomposeLayout and BoxWithConstraints

`SubcomposeLayout` lets you **compose** content during the layout phase, so what you compose can depend on measured sizes. `LazyColumn`, `Scaffold`, and `BoxWithConstraints` are built on it.

```kotlin
BoxWithConstraints {
    if (maxWidth < 600.dp) CompactLayout() else ExpandedLayout()
}
```

> **Pitfall:** Subcomposition is more expensive than normal layout. Do not use `BoxWithConstraints` just to read the width. For window-level decisions, prefer window size classes (`currentWindowAdaptiveInfo()`), and for simple cases use `Modifier.layout` or weights.

## Lazy Lists and Grids

### Basics

`LazyColumn`, `LazyRow`, `LazyVerticalGrid`, `LazyHorizontalGrid`, `LazyVerticalStaggeredGrid`, and pagers compose and lay out only the visible items (plus a small prefetch).

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

### Keys

By default an item's identity is its **position**. If you insert at the top, every item shifts, and remembered state moves to the wrong item.

- `items(key = { it.id })` gives each item a stable identity. State and scroll position follow the item. It also enables item animations with `Modifier.animateItem()`.
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

`contentType` tells Compose which items have the same structure. Compose can then reuse compositions only between items of the same type, which makes reuse more effective in mixed lists (headers, ads, rows).

### Performance tips for lazy lists

- Always provide `key` for dynamic data.
- Provide `contentType` for heterogeneous lists.
- Never nest a `LazyColumn` inside a vertically scrollable `Column` with no height limit. It crashes because the inner list gets infinite height constraints. Use one `LazyColumn` with multiple `item`/`items` blocks.
- Avoid zero-sized items (for example images before loading). Give placeholders a size so Compose does not compose too many items on the first pass.
- Keep item composables light. Do sorting, filtering, and formatting in the ViewModel, not in `items {}`.
- Use `derivedStateOf` for reads of `LazyListState` such as `firstVisibleItemIndex`.
- Measure performance in a **release** build with R8 enabled. Debug builds are much slower.

> **Interview:** "Why is my LazyColumn janky?" Check: debug build, missing keys, heavy item composition, unstable item data rebuilt every recomposition, images without fixed size, and work in the composition body.

## Theming and Navigation

### Material 3 theming

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
    MaterialTheme(colorScheme = colorScheme, typography = AppTypography, shapes = AppShapes, content = content)
}
```

- **colorScheme:** semantic roles like `primary`, `onPrimary`, `surface`, `onSurface`, `surfaceContainer`, `error`. Use roles, never hard-coded colors.
- **typography:** text styles like `displayLarge`, `titleMedium`, `bodyLarge`, `labelSmall`.
- **shapes:** `small`, `medium`, `large` corner shapes.
- **Dynamic color** (Material You) derives colors from the wallpaper on Android 12 (API 31) and above.
- **Dark mode:** `isSystemInDarkTheme()` reads the system setting. Provide both light and dark schemes.
- Read tokens through `MaterialTheme.colorScheme.primary`, `MaterialTheme.typography.titleLarge`.

`Surface` sets `LocalContentColor` to the matching "on" color, so `Text` inside a `primary` surface automatically uses `onPrimary`.

> **Tip:** For brand tokens Material does not cover (spacing, extra colors), add your own CompositionLocals and expose them through an object, for example `AppTheme.spacing`.

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
            ProfileScreen(userId = route.userId)
        }
    }
}
```

- Pass **IDs**, not whole objects. Load data from the repository on the destination.
- In the ViewModel, read arguments with `savedStateHandle.toRoute<Profile>()`.
- Do not pass `navController` deep into screens. Pass lambdas like `onOpenProfile`. This keeps screens testable and previewable.
- Use `navigate(route) { popUpTo(Home) { inclusive = false }; launchSingleTop = true }` to control the back stack.

> **Note:** Navigation 3 is a newer, separate library where you own the back stack as a list of keys. Know it exists, but Navigation Compose with type-safe routes is still the common interview baseline.

### ViewModel integration

```kotlin
@Composable
fun ProfileRoute(viewModel: ProfileViewModel = hiltViewModel()) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    ProfileScreen(uiState = uiState, onRetry = viewModel::retry)
}

@Composable
fun ProfileScreen(uiState: ProfileUiState, onRetry: () -> Unit) { /* stateless */ }
```

- `viewModel()` (lifecycle-viewmodel-compose) or `hiltViewModel()` (Hilt) gets a ViewModel scoped to the nearest `ViewModelStoreOwner`. Inside a `NavHost` that is the back stack entry, so each destination gets its own ViewModel.
- `collectAsStateWithLifecycle()` (lifecycle-runtime-compose) stops collecting when the lifecycle drops below `STARTED`. This saves work when the app is in the background. Prefer it over `collectAsState()` on Android.
- Split into a **Route** (gets ViewModel, collects state) and a **Screen** (stateless). Previews and UI tests target the Screen.
- Never pass the ViewModel down to child composables.

## Animations and Gestures

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

### Examples

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

```kotlin
val transition = updateTransition(targetState = expanded, label = "card")
val elevation by transition.animateDp(label = "elevation") { if (it) 8.dp else 1.dp }
val corner by transition.animateDp(label = "corner") { if (it) 0.dp else 16.dp }
```

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

- `animationSpec` options: `spring()` (default for most, handles interruptions smoothly), `tween(durationMillis, easing)`, `keyframes { }`, `repeatable`, `infiniteRepeatable`.
- `Animatable.animateTo` is a suspend function. Calling it again cancels the running animation and continues from the current value and velocity.
- Use the `label` parameter. It names the animation in Android Studio's Animation Preview.
- Combine animations with late reads: animate a value, read it inside `graphicsLayer {}` or `offset {}`.

### Gestures basics

High-level modifiers handle most cases:

- `Modifier.clickable`, `combinedClickable` (long click, double click), `toggleable`, `selectable`.
- `Modifier.verticalScroll(rememberScrollState())`, `horizontalScroll`.
- `Modifier.draggable(rememberDraggableState { delta -> })` for one axis.
- `Modifier.transformable(rememberTransformableState { zoom, pan, rotation -> })` for pinch and rotate.
- `Modifier.anchoredDraggable` for snapping between anchors (swipe-to-dismiss style).

For custom gestures, use `pointerInput`:

```kotlin
Modifier.pointerInput(Unit) {
    detectTapGestures(
        onDoubleTap = { offset -> onDoubleTap(offset) },
        onLongPress = { onLongPress() }
    )
}
```

Other detectors: `detectDragGestures`, `detectTransformGestures`, `detectHorizontalDragGestures`.

> **Pitfall:** The `pointerInput` block restarts only when its key changes. If the block captures a value that changes, either pass it as a key or read it through `rememberUpdatedState`. Otherwise the gesture uses a stale value.

> **Tip:** Prefer `clickable` over `pointerInput { detectTapGestures }` for simple clicks. `clickable` also provides ripple, focus, and accessibility semantics.

## Interop, Testing, Tooling

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
- `update` runs on first composition and again when state it reads changes.
- Use `onRelease` (and `onReset` for reuse in lazy lists) to clean up.
- For XML layouts with View Binding, use `AndroidViewBinding`.

### Compose inside Views: ComposeView

```kotlin
override fun onCreateView(inflater: LayoutInflater, c: ViewGroup?, s: Bundle?): View =
    ComposeView(requireContext()).apply {
        setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
        setContent { AppTheme { ProfileScreen() } }
    }
```

In Fragments, set `DisposeOnViewTreeLifecycleDestroyed` so the composition follows the Fragment's view lifecycle, not the Fragment itself. Inside RecyclerView, recent versions handle pooling well with the default strategy.

> **Tip:** Migrate bottom up or screen by screen. Wrap the existing View theme with a Compose theme that matches it, so both worlds look the same during migration.

### Testing

Compose UI tests work on the **semantics tree**, a parallel tree that describes meaning (text, role, content description, state) for accessibility and tests.

```kotlin
class LoginScreenTest {
    @get:Rule val composeTestRule = createComposeRule()

    @Test
    fun showsErrorOnEmptySubmit() {
        composeTestRule.setContent {
            AppTheme { LoginScreen(state = LoginUiState(), onSubmit = {}) }
        }
        composeTestRule.onNodeWithText("Log in").performClick()
        composeTestRule.onNodeWithTag("error").assertIsDisplayed()
        composeTestRule.onNodeWithText("Email is required").assertExists()
    }
}
```

- **Rules:** `createComposeRule()` for testing composables alone. `createAndroidComposeRule<MainActivity>()` when you need a real Activity.
- **Finders:** `onNodeWithText`, `onNodeWithContentDescription`, `onNodeWithTag`, `onAllNodesWithText`, `onNode(hasText("x") and hasClickAction())`.
- **Actions:** `performClick`, `performTextInput`, `performScrollTo`, `performTouchInput { swipeLeft() }`.
- **Assertions:** `assertIsDisplayed`, `assertExists`, `assertDoesNotExist`, `assertTextEquals`, `assertIsEnabled`, `assertIsSelected`.
- Add `Modifier.testTag("error")` for nodes without unique text.
- Child semantics are often **merged** into the parent (for example a `Button` merges its `Text`). Use `useUnmergedTree = true` in finders to see children.
- Debug with `composeTestRule.onRoot().printToLog("TAG")`.
- Compose tests are synchronized automatically: they wait for idle (recomposition, animations). Control time with `composeTestRule.mainClock.autoAdvance = false` and `advanceTimeBy()`.
- Use `waitUntil { }` for async conditions.
- Screenshot testing (for example Compose Preview Screenshot Testing, Paparazzi, Roborazzi) complements semantic tests.

> **Tip:** Test the stateless Screen composable with fake state. Test the ViewModel with plain unit tests. Keep few end-to-end tests.

### Tooling

- **@Preview:** with `uiMode`, `fontScale`, `device`, and multipreview annotations like `@PreviewLightDark` and `@PreviewScreenSizes`. `@PreviewParameter` feeds sample data.
- **Layout Inspector:** shows the composable tree, parameters, and **recomposition counts and skip counts** for each composable. A count that climbs fast while nothing visible changes is a red flag.
- **Compose compiler reports and metrics:** show which composables are restartable and skippable, and which parameters are stable.

```kotlin
// module build.gradle.kts
composeCompiler {
    reportsDestination = layout.buildDirectory.dir("compose_compiler")
    metricsDestination = layout.buildDirectory.dir("compose_compiler")
}
```

- **Composition tracing:** with the runtime tracing dependency, composable names appear in system traces (Perfetto / Android Studio profiler).
- **Baseline Profiles:** Compose is a library shipped with your app, not part of the OS, so its code starts interpreted and JIT compiled. A Baseline Profile lists hot code paths so they are compiled ahead of time on install. This improves startup and first-scroll smoothness. Generate one with the Baseline Profile Gradle plugin and a Macrobenchmark module.
- **Macrobenchmark:** measure startup and frame timing (jank) on a real device in release mode.

## Performance and Pitfalls

### Performance checklist

1. Measure in a **release build** with R8 and a Baseline Profile before optimizing.
2. Use Layout Inspector recomposition counts to find hot spots.
3. Read fast-changing state (scroll, animation) in **layout or draw** with lambda modifiers.
4. Use `derivedStateOf` for "changes less often than its input" state.
5. Wrap expensive calculations in `remember(keys)`, or move them to the ViewModel.
6. Avoid creating new list or object instances in composition that are passed to children.
7. Give lazy items `key` and `contentType`.
8. Do not write state that was already read in the same composition (backwards writes).
9. Keep composables small so recomposition scopes are small.
10. Avoid unnecessary `SubcomposeLayout` / `BoxWithConstraints`.
11. Prefer `collectAsStateWithLifecycle` so hidden screens do not keep working.
12. Check stability with compiler reports when a composable recomposes more than expected.

### Common pitfalls

- **Forgetting `remember`:** `val state = mutableStateOf(0)` without `remember` resets every recomposition. Lint warns about this.
- **Mutating a list in place:** `list.add()` on a normal `MutableList` inside `mutableStateOf` does not trigger recomposition.
- **Backwards write:** writing state after reading it in the same composition causes an endless recomposition loop.

```kotlin
@Composable
fun BadCounter() {
    var count by remember { mutableIntStateOf(0) }
    Text("$count")
    count++ // backwards write: recomposes forever
}
```

- **Side effects in the body:** network calls, analytics, or `viewModel.load()` directly in a composable. Use `LaunchedEffect` or, better, trigger loading from the ViewModel itself.
- **Wrong effect keys:** `LaunchedEffect(Unit)` reading a parameter that changes. Use the value as a key or `rememberUpdatedState`.
- **Lazy list without keys:** remembered state (like an expanded card) jumps to the wrong row after inserts.
- **Nested scrolling in the same direction** with an unbounded lazy list.
- **Passing ViewModel or NavController deep into the tree:** kills previews and testability.
- **Sharing the `modifier` parameter** with several children, or applying it to a child instead of the root.
- **Heavy work in `items {}`:** sorting or date formatting per item, per recomposition.
- **Using `remember` for things that must survive rotation:** use `rememberSaveable` or a ViewModel.
- **Overusing CompositionLocal** for screen data.
- **Lying with `@Immutable`/`@Stable`:** the UI stops updating.
- **Measuring performance in debug builds** and drawing wrong conclusions.

## Interview Questions

### Q: What is recomposition, and what triggers it?

Recomposition is Compose calling composable functions again to update the UI. It is triggered when a `State` object that was read during composition gets a new value. Compose only re-runs the scopes that read that state and skips children whose inputs did not change. Plain variables and in-place mutation of normal collections do not trigger it.

### Q: Explain the three phases of a frame.

Composition decides what to show by running composables. Layout measures and places each node, with each child measured once. Drawing renders pixels. A state read in a phase only invalidates that phase and the ones after it, so reading state in layout or draw (with `offset {}`, `graphicsLayer {}`, `drawBehind {}`) avoids recomposition.

### Q: remember vs rememberSaveable vs ViewModel?

`remember` keeps a value across recompositions only. `rememberSaveable` also survives configuration changes and process death by saving to the Bundle, so it suits small UI state like text input or a selected tab. A ViewModel survives configuration changes, holds screen-level state and business logic, and uses `SavedStateHandle` for process death.

### Q: When do you use derivedStateOf?

When a result changes less often than the state it depends on, like "is the list scrolled past the first item". It prevents recomposition on every input change. Wrap it in `remember`. Do not use it when the output changes as often as the input.

### Q: LaunchedEffect vs rememberCoroutineScope?

`LaunchedEffect` starts a coroutine as part of composition, keyed and restarted by its keys, and cancelled when it leaves. `rememberCoroutineScope` gives you a scope to launch coroutines from callbacks like clicks, which are outside composition. You cannot call `LaunchedEffect` inside an `onClick`.

### Q: What does rememberUpdatedState solve?

A long-running effect captures values at launch. If a parameter like a callback changes, the effect would use the old one. Restarting the effect may be wrong (for example a timer). `rememberUpdatedState` keeps a reference that always points to the latest value without restarting the effect.

### Q: What is state hoisting and why do it?

Moving state from a composable to its caller, replacing it with a `value` parameter and an `onValueChange` event. The child becomes stateless, which makes it reusable, previewable, and testable, and it creates a single source of truth with unidirectional data flow.

### Q: What does stability mean, and how did strong skipping change it?

A stable type lets Compose trust `equals` and observe changes, so it can safely skip a composable when parameters are equal. Before strong skipping, a composable with any unstable parameter could not skip. Since Kotlin 2.0.20 strong skipping is the default: all restartable composables are skippable, unstable parameters are compared by instance identity, and lambdas are remembered automatically. So the main risk now is creating new instances on every recomposition.

### Q: Why do LazyColumn items need keys?

Without keys, identity is the item's index. Inserting or removing items shifts indices, so remembered state and animations attach to the wrong items. A stable unique key keeps state with the data item, preserves scroll position, and enables `animateItem()`. `contentType` additionally improves composition reuse across item types.

### Q: Why does modifier order matter? Give an example.

Each modifier wraps the ones after it, so order defines the result. `padding().background()` leaves the padding outside the colored area, while `background().padding()` colors the padding too. `clickable().padding()` makes the padding clickable; `padding().clickable()` does not.

### Q: compositionLocalOf vs staticCompositionLocalOf?

With `compositionLocalOf`, Compose tracks readers and only recomposes those that read `.current` when the value changes. With `staticCompositionLocalOf`, there is no tracking, so a change recomposes the whole provided subtree, but reads are cheaper. Use static for values that rarely or never change, like theme tokens.

### Q: Why can a child only be measured once in Compose?

The single-pass rule keeps layout linear in the number of nodes, so deep nesting stays cheap. Measuring a child twice throws. When you need information before measuring, use intrinsic measurements, or `SubcomposeLayout` when you must compose content based on measured size.

### Q: How do you collect a Flow from a ViewModel in Compose?

Expose a `StateFlow<UiState>` and call `collectAsStateWithLifecycle()` in a route-level composable. It stops collecting below the `STARTED` state, so background screens do not do work. Then pass plain state and lambdas to a stateless screen.

### Q: How would you debug a screen that recomposes too much?

Check a release build first. Use Layout Inspector recomposition and skip counts to find the hot composable. Look for state read too high in the tree, fast-changing values read in composition instead of layout or draw, new objects or lists created every recomposition, missing `derivedStateOf`, and unstable types via compiler reports. Then fix by deferring reads, remembering, or changing the data model.

### Q: How do Compose UI tests find elements?

Through the semantics tree. Finders like `onNodeWithText`, `onNodeWithTag`, and `onNodeWithContentDescription` match semantics properties. Actions and assertions run on those nodes, and the test rule synchronizes with Compose so you do not need manual waits for recomposition. Use `useUnmergedTree` to reach merged children.

### Q: What are Baseline Profiles and why do they matter more for Compose?

A Baseline Profile is a list of classes and methods to compile ahead of time when the app installs. Compose ships inside your APK rather than the OS, so without a profile its code runs interpreted or JIT compiled at first, causing slower startup and early jank. Profiles fix this for critical user journeys.

## Cheat Sheet and Practice

### Cheat sheet

| Topic | Remember this |
|---|---|
| Mental model | UI = f(state); state down, events up |
| Composable rules | Fast, idempotent, side-effect free, may skip, any order |
| Phases | Composition, layout, draw; read state as late as possible |
| Late reads | `offset {}`, `graphicsLayer {}`, `drawBehind {}`, `layout {}` |
| State | `remember { mutableStateOf() }`; primitives use `mutableIntStateOf` |
| Survive rotation | `rememberSaveable` (with Saver) or ViewModel |
| Less frequent result | `remember { derivedStateOf {} }` |
| State to Flow | `snapshotFlow {}` inside `LaunchedEffect` |
| Lists in state | `mutableStateListOf` or replace an immutable List |
| Stability | Strong skipping default; unstable params compared by `===` |
| Suspend work on key change | `LaunchedEffect(key)` |
| Cleanup | `DisposableEffect` with `onDispose` |
| Coroutine from click | `rememberCoroutineScope` |
| Latest value in long effect | `rememberUpdatedState` |
| CompositionLocal | Static for rarely changing; prefer explicit params |
| Modifiers | Order is outside-in; accept and apply `modifier` first on root |
| Custom modifier | Chain existing, else `Modifier.Node` (not `composed`) |
| Layout | Measure each child once; intrinsics or SubcomposeLayout when needed |
| Lazy lists | `key`, `contentType`, no unbounded nested scroll |
| Flows | `collectAsStateWithLifecycle` in route composable |
| Navigation | `@Serializable` routes, `toRoute()`, pass IDs, pass lambdas |
| Perf tools | Layout Inspector counts, compiler reports, Baseline Profiles, Macrobenchmark |

### Practice exercises

1. **Scroll-aware header.** Build a `LazyColumn` with a header image that moves at half the scroll speed and fades out. Use `Modifier.graphicsLayer {}` so Layout Inspector shows zero recompositions while scrolling. Add a "scroll to top" FAB driven by `derivedStateOf`.
2. **Hoisted form.** Build a sign-up form with name, email, and password fields. Make every field stateless. Put validation in a ViewModel exposing `StateFlow<SignUpUiState>`. Write a Compose UI test that types an invalid email and checks the error text.
3. **Custom layout.** Implement a `FlowTags` layout with `Layout` that places chips left to right and wraps to a new line. Respect constraints and RTL with `placeRelative`. Then compare with the built-in `FlowRow`.
4. **Effects drill.** Write a composable that starts a 5-second countdown, calls `onFinished` at the end, restarts when a `sessionId` changes, and uses the latest `onFinished` without restarting. Add a `DisposableEffect` that logs when the screen leaves.
5. **Recomposition hunt.** Take a list screen with a `List<Item>` filtered in the composable body and an animated background color using `Modifier.background`. Turn on compiler reports and Layout Inspector counts, explain each problem, and fix both.

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
