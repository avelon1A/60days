Presentation architecture decides where your screen logic lives, how state flows to the UI, and how user actions flow back. On modern Android this means a Jetpack `ViewModel`, Kotlin `Flow`, and Compose, arranged as either MVVM or MVI. These notes cover the why, the history, Google's recommended layers, both patterns in depth with a full worked example, testing, and the interview questions you are most likely to face.

## Why Architecture

An Android screen is hard to get right. The system can destroy and recreate your Activity at any time. The user can rotate the phone, change the language, switch to dark mode, or resize a window. The OS can kill your whole process while the app is in the background. Network calls are slow and can fail. Without a plan, all of this ends up tangled inside one Activity.

Good architecture gives you four things:

- **Separation of concerns.** UI code draws pixels. Business logic decides what to show. Data code fetches and stores. Each part changes for its own reasons.
- **Testability.** Logic that does not touch `Context` or Views can run in fast JVM unit tests, without an emulator.
- **Surviving configuration changes.** State held in a `ViewModel` survives rotation. You do not re-fetch data every time the user turns the phone.
- **Surviving process death.** Small, critical UI state (a search query, a selected tab, a form draft) is saved with `SavedStateHandle` and restored when the user returns.

It also gives a team a shared language. When every screen has the same shape, a new developer can open any feature and know where to look.

> **Interview:** When asked "why do we need architecture?", name the concrete Android problems: config changes, process death, lifecycle-aware async work, and testability. Generic answers like "clean code" sound junior.

### Config change vs process death

These two are often confused, so be precise.

| Event | What is destroyed | What survives | Tool |
|---|---|---|---|
| Configuration change (rotation, theme, locale) | Activity and its Views or composition | ViewModel instances | `ViewModel` |
| Process death (low memory while backgrounded) | The whole process, including all ViewModels | Saved instance state Bundle | `SavedStateHandle`, `rememberSaveable` |
| User finishes the screen (back press) | Activity and ViewModel | Nothing for that screen | Persistent storage if needed |

> **Pitfall:** A ViewModel does NOT survive process death. If you only keep the search query in a `MutableStateFlow`, the user comes back to an empty screen after the OS kills the app.

## History: MVC to MVI

Each pattern was a reaction to a pain in the one before it.

### MVC (Model View Controller)

Early Android apps used the Activity as both View and Controller. The Activity inflated layouts, handled clicks, called the network, and parsed results. This produced the famous "massive Activity". Nothing was testable without a device, and rotation lost all in-flight work.

### MVP (Model View Presenter)

MVP pulled logic into a `Presenter`. The Activity implemented a `View` interface such as `showLoading()` and `showUsers(list)`. The Presenter held a reference to that interface and called it.

- Solved: logic moved into a plain class that could be unit tested with a mocked View interface.
- New problems: the Presenter held a reference to the View, so you had to attach and detach it on lifecycle events to avoid leaks. Presenters did not survive rotation by default. The View interface grew huge, and the UI state was spread across many imperative calls, so it was easy to end up in an inconsistent state (loading spinner and error shown at the same time).

### MVVM (Model View ViewModel)

MVVM flips the dependency. The ViewModel does not know the View. It exposes observable state, and the View observes it. In 2017 Google shipped Architecture Components with `ViewModel` and `LiveData`, which made MVVM the default on Android.

- Solved: no View reference, so no leaks. Jetpack ViewModel survives config changes. Observation replaced imperative "show X" calls.
- New problems: teams often exposed many separate streams (`isLoading`, `error`, `items`), which could still disagree with each other. Events like "show a snackbar" were awkward with `LiveData` (the `SingleLiveEvent` hack).

### MVI (Model View Intent)

MVI came from the web world (Cycle.js, Redux, Elm). It adds strict rules on top of MVVM: one immutable state object per screen, all user input expressed as typed intents, and state changes made only by a reducer. Data flows in one direction.

- Solved: a single source of truth for the screen, so impossible combinations are much harder. Every state change has a named cause, which makes logging and debugging easy.
- Cost: more boilerplate (sealed classes for intents, effects, and internal results).

> **Note:** Modern "Google style" MVVM already borrows most of MVI's ideas: a single `UiState`, immutable data, and unidirectional data flow. In practice the line between the two is blurry. The main difference is whether user input is a typed `Intent` sent to one entry point, or a set of plain functions on the ViewModel.

## Google's Layered Architecture

Google's [Guide to app architecture](https://developer.android.com/topic/architecture) recommends three layers. Dependencies point inward: UI depends on domain, domain depends on data. Never the other way.

```text
+--------------------------------------------------+
| UI layer                                         |
|   UI elements (Compose / Views)                  |
|   State holders (ViewModel)                      |
+--------------------------------------------------+
                 |  calls          ^ state (Flow)
                 v                 |
+--------------------------------------------------+
| Domain layer (optional)                          |
|   Use cases: GetSearchResultsUseCase ...         |
+--------------------------------------------------+
                 |                 ^
                 v                 |
+--------------------------------------------------+
| Data layer                                       |
|   Repositories  ->  Data sources (Room, Retrofit)|
+--------------------------------------------------+
```

### UI layer

The UI layer has two parts. **UI elements** render data (composables or Views). **State holders** (usually a `ViewModel`) hold the state, apply screen logic, and expose it. The UI layer turns app data into UI state, for example mapping a `User` into a `ProfileUiState` with formatted strings.

### Domain layer (optional)

The domain layer holds reusable business logic in **use cases** (also called interactors). Each use case does one thing. Google's naming convention is verb + noun + `UseCase`, for example `GetLatestNewsWithAuthorsUseCase`. Use cases are usually invoked as functions with `operator fun invoke`.

```kotlin
class FormatDateUseCase @Inject constructor(
    private val userRepository: UserRepository,
) {
    suspend operator fun invoke(date: Instant): String {
        val locale = userRepository.getPreferredLocale()
        return DateTimeFormatter.ofPattern("d MMM yyyy", locale)
            .withZone(ZoneId.systemDefault())
            .format(date)
    }
}
```

Add a domain layer when logic is reused by several ViewModels, or when combining several repositories gets complex. Do not add it by default to every screen. A use case that only forwards one repository call adds files without adding value.

### Data layer

The data layer holds **repositories** and **data sources**. A data source works with exactly one source of data: a Room DAO, a Retrofit API, DataStore. A repository combines data sources, resolves conflicts, and exposes clean data to the rest of the app.

- Repositories expose `suspend` functions for one-shot operations and `Flow` for data that changes over time.
- Repository classes are named after the data they own: `NewsRepository`, `UserRepository`.
- All public functions must be **main-safe**: callers can use them from the main thread. The repository or data source switches to `Dispatchers.IO` itself.

### Single source of truth and offline-first

Each piece of data should have one owner, the **single source of truth (SSOT)**. Only the owner can change it. Everyone else gets an immutable view.

In an **offline-first** app, the local database is the SSOT. The network is used only to refresh the database. The UI observes the database through a `Flow`, so it always shows something, even with no network.

```kotlin
class OfflineFirstNewsRepository @Inject constructor(
    private val dao: NewsDao,
    private val api: NewsApi,
) : NewsRepository {
    // UI reads only from the database
    override fun observeNews(): Flow<List<News>> =
        dao.observeAll().map { rows -> rows.map { it.toModel() } }

    // Network only writes into the database
    override suspend fun refresh() {
        val remote = api.fetchLatest()
        dao.upsertAll(remote.map { it.toEntity() })
    }
}
```

> **Tip:** Unidirectional data flow (UDF) is the rule that ties the layers together: state flows down (data to UI), events flow up (UI to data). Google uses the term UDF throughout its docs, so use it in interviews.

## Jetpack ViewModel Deep Dive

### What a ViewModel is

A `ViewModel` is a screen-level state holder that outlives configuration changes. It is scoped to a `ViewModelStoreOwner`: an Activity, a Fragment, or a Navigation back stack entry. It lives until that owner is finished for good.

```text
Activity created  ->  ViewModel created
Rotation          ->  Activity destroyed + recreated, SAME ViewModel
Back pressed      ->  Activity finished  ->  ViewModel.onCleared()
```

### How it survives configuration changes

> **Under the hood:** Each `ViewModelStoreOwner` has a `ViewModelStore`, which is basically a map from key to ViewModel. `ComponentActivity` passes this store across the recreation using `onRetainNonConfigurationInstance()`. When the Activity is destroyed, it checks `isChangingConfigurations`; if true it keeps the store, if false it calls `clear()` on the store, which calls `onCleared()` on every ViewModel.

`ViewModelProvider` looks up the ViewModel by key in the store. If it exists, it returns the same instance. If not, it uses a factory to create one. In Compose, `viewModel()` and `hiltViewModel()` wrap this logic and use the nearest `LocalViewModelStoreOwner`.

### onCleared and viewModelScope

`onCleared()` is called once, when the owner is gone for good. `viewModelScope` is a `CoroutineScope` tied to the ViewModel. It is cancelled automatically when the ViewModel is cleared.

```kotlin
class ProfileViewModel(private val repo: UserRepository) : ViewModel() {
    init {
        viewModelScope.launch {
            // Cancelled automatically when the ViewModel is cleared
            repo.refreshProfile()
        }
    }

    override fun onCleared() {
        // Release non-coroutine resources here
        super.onCleared()
    }
}
```

> **Under the hood:** `viewModelScope` uses `SupervisorJob() + Dispatchers.Main.immediate`. Because of the SupervisorJob, one failed child coroutine does not cancel its siblings. Recent lifecycle versions also let you register `AutoCloseable` resources with `addCloseable()`, and they are closed when the ViewModel is cleared.

### SavedStateHandle and process death

`SavedStateHandle` is a key-value map that is written into the saved instance state `Bundle`. It survives process death. You get it injected into the ViewModel constructor (Hilt and the default factories support it).

```kotlin
@HiltViewModel
class SearchViewModel @Inject constructor(
    private val savedStateHandle: SavedStateHandle,
) : ViewModel() {
    // Restored after process death
    val query: StateFlow<String> =
        savedStateHandle.getStateFlow(KEY_QUERY, "")

    fun onQueryChange(newQuery: String) {
        savedStateHandle[KEY_QUERY] = newQuery
    }

    private companion object { const val KEY_QUERY = "query" }
}
```

Rules for `SavedStateHandle`:

- Store only small, `Bundle`-friendly data: ids, query strings, selected tab, scroll anchors. Not lists of results.
- Re-load big data from the repository using the saved id.
- Navigation arguments are also available through `SavedStateHandle`. With type-safe Navigation Compose you can read them with `savedStateHandle.toRoute<MyRoute>()`.

> **Tip:** To test process death manually, put the app in the background and run `adb shell am kill your.package.name`, then reopen it from Recents. The "Don't keep activities" developer option only tests Activity recreation, not a real process kill.

### Factories and CreationExtras

If a ViewModel has constructor parameters, the system needs a factory. The modern way uses `CreationExtras` and the `viewModelFactory` DSL.

```kotlin
class DetailViewModel(
    private val repo: DetailRepository,
    private val savedStateHandle: SavedStateHandle,
) : ViewModel() {
    companion object {
        val Factory: ViewModelProvider.Factory = viewModelFactory {
            initializer {
                val app = this[APPLICATION_KEY] as MyApplication
                DetailViewModel(
                    repo = app.container.detailRepository,
                    savedStateHandle = createSavedStateHandle(),
                )
            }
        }
    }
}

// In Compose
val vm: DetailViewModel = viewModel(factory = DetailViewModel.Factory)
```

`CreationExtras` is a bag of values the system passes to the factory, such as the `Application` and what is needed to build a `SavedStateHandle`. This replaced older factory types like `AndroidViewModelFactory` and `AbstractSavedStateViewModelFactory` for most cases.

### Hilt and @HiltViewModel

With Hilt you skip factories entirely.

```kotlin
@HiltViewModel
class CartViewModel @Inject constructor(
    private val cartRepository: CartRepository,
    private val savedStateHandle: SavedStateHandle,
) : ViewModel()

@Composable
fun CartRoute(viewModel: CartViewModel = hiltViewModel()) { /* ... */ }
```

- Annotate the class with `@HiltViewModel` and the constructor with `@Inject`.
- In Views, use `by viewModels()` in an `@AndroidEntryPoint` Activity or Fragment.
- In Compose, use `hiltViewModel()`. Inside a navigation graph it scopes the ViewModel to the current back stack entry.
- For runtime values that are not in `SavedStateHandle`, Hilt supports assisted injection with `@HiltViewModel(assistedFactory = ...)`.

> **Pitfall:** Never create a ViewModel with its constructor directly (`MyViewModel()`) in UI code. It will not be stored in a `ViewModelStore`, so it is recreated on every config change and `onCleared()` never runs.

## Exposing UI State

### One immutable UiState

Google recommends modelling the screen as one immutable state object. The UI renders it. It never mutates it.

```kotlin
data class NewsUiState(
    val isLoading: Boolean = false,
    val articles: List<ArticleUi> = emptyList(),
    val userMessage: String? = null,
    val isSignedIn: Boolean = false,
)
```

Benefits: the screen is always consistent, it is easy to log, and tests compare one object.

You can also use a sealed interface when the states are mutually exclusive:

```kotlin
sealed interface ProfileUiState {
    data object Loading : ProfileUiState
    data class Success(val name: String, val avatarUrl: String) : ProfileUiState
    data class Error(val message: String) : ProfileUiState
}
```

Use a sealed type when only one case can exist at a time. Use a data class with flags when parts of the screen are independent (for example a refresh spinner on top of existing content). Many real screens combine both: a data class that contains a sealed `content` field.

### Single stream vs multiple streams

| Approach | Good | Bad |
|---|---|---|
| One `StateFlow<UiState>` | Always consistent, simple to test | Unrelated fields cause the whole object to be re-emitted |
| Several `StateFlow`s | Independent parts update independently | Streams can disagree, UI must combine them |

Start with one stream. Split only when parts are truly unrelated and change at very different rates. In Compose, re-emitting one object is cheap because composables that read unchanged fields are skipped.

### MutableStateFlow and update

For state the ViewModel owns, keep a private `MutableStateFlow` and expose a read-only `StateFlow`.

```kotlin
private val _uiState = MutableStateFlow(NewsUiState())
val uiState: StateFlow<NewsUiState> = _uiState.asStateFlow()

fun onBookmark(id: String) {
    _uiState.update { state ->
        state.copy(articles = state.articles.map {
            if (it.id == id) it.copy(isBookmarked = true) else it
        })
    }
}
```

> **Tip:** Always use `update { }` instead of `_uiState.value = _uiState.value.copy(...)`. `update` is atomic (a compare-and-set loop), so two concurrent updates cannot overwrite each other.

### Deriving state with combine and stateIn

When state comes from repository flows, derive it instead of copying values into a `MutableStateFlow`.

```kotlin
val uiState: StateFlow<NewsUiState> = combine(
    newsRepository.observeNews(),
    userRepository.observeIsSignedIn(),
) { news, signedIn ->
    NewsUiState(articles = news.map { it.toUi() }, isSignedIn = signedIn)
}.stateIn(
    scope = viewModelScope,
    started = SharingStarted.WhileSubscribed(5_000),
    initialValue = NewsUiState(isLoading = true),
)
```

`stateIn` turns a cold `Flow` into a hot `StateFlow`. The three `SharingStarted` options:

- `Eagerly`: starts at once, never stops.
- `Lazily`: starts on the first subscriber, never stops.
- `WhileSubscribed(5_000)`: starts on the first subscriber and stops 5 seconds after the last one leaves.

> **Interview:** Why 5,000 ms? A configuration change takes well under 5 seconds, so the upstream stays alive during rotation and nothing is re-fetched. But when the app goes to the background for longer, the upstream stops, which saves battery and database or network work.

### Collecting in Compose

```kotlin
@Composable
fun NewsRoute(viewModel: NewsViewModel = hiltViewModel()) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    NewsScreen(uiState = uiState, onBookmark = viewModel::onBookmark)
}
```

`collectAsStateWithLifecycle()` (from `lifecycle-runtime-compose`) stops collecting when the lifecycle drops below `STARTED`. Plain `collectAsState()` keeps collecting in the background, which also keeps `WhileSubscribed` upstreams alive.

> **Tip:** Split each screen into a "Route" composable (gets the ViewModel, collects state) and a stateless "Screen" composable (takes `uiState` and lambdas). The stateless one is easy to preview and to test.

In the View system, collect with `repeatOnLifecycle`:

```kotlin
lifecycleScope.launch {
    repeatOnLifecycle(Lifecycle.State.STARTED) {
        viewModel.uiState.collect { render(it) }
    }
}
```

## UI Events and One-off Effects

### Two kinds of events

- **User events** go up from the UI to the ViewModel: a click, text input, pull to refresh. These are just function calls (MVVM) or intents (MVI).
- **ViewModel events** go down from the ViewModel to the UI: "show a snackbar", "navigate to detail". These are the tricky ones.

Some user events never need the ViewModel at all. Expanding a card or scrolling a list is pure UI logic and can live in composable state.

### Google's guidance: events are state

Google's current guidance is that ViewModel events should result in a UI state update. Instead of firing a "show message" event, add the message to the state. The UI shows it, then tells the ViewModel it was shown.

```kotlin
data class UiState(val userMessage: String? = null /* ... */)

fun onSaveFailed() {
    _uiState.update { it.copy(userMessage = "Could not save") }
}

fun userMessageShown() {
    _uiState.update { it.copy(userMessage = null) }
}
```

```kotlin
uiState.userMessage?.let { message ->
    LaunchedEffect(message) {
        snackbarHostState.showSnackbar(message)
        viewModel.userMessageShown()
    }
}
```

Why: state cannot be lost. It survives rotation, and if the UI was not visible when the event happened, it is still there when the UI comes back. Navigation can be modelled the same way, for example an `isSaved: Boolean` that the UI reacts to by navigating, then reporting back.

> **Note:** For an action that the UI can handle immediately in response to a user click, such as navigating when a button is tapped, you often do not need the ViewModel round trip at all. Call the navigation lambda directly from the UI.

### Channel vs SharedFlow for effects

Many teams, and almost every MVI library, still use a separate effect stream. Know the trade-offs.

| Option | Behaviour with no collector | Multiple collectors | Main risk |
|---|---|---|---|
| `Channel(BUFFERED)` + `receiveAsFlow()` | Buffers until someone collects | Each event goes to one collector only | Event can be lost in the small window between delivery and handling |
| `MutableSharedFlow(replay = 0)` | Event is dropped | Every collector gets it | Events sent while UI is stopped are lost |
| `MutableSharedFlow(replay = 1)` | Last event is kept | Every collector gets it | Old event replays after rotation (double navigation) |
| State + "consumed" callback | Kept in state | Any observer | Slightly more code, but no loss |

Channel is the usual choice for one-off effects. To avoid losing events during a configuration change, collect on `Dispatchers.Main.immediate` inside a lifecycle-aware block.

```kotlin
@Composable
fun <T> ObserveAsEvents(flow: Flow<T>, onEvent: (T) -> Unit) {
    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(flow, lifecycleOwner) {
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
            withContext(Dispatchers.Main.immediate) {
                flow.collect(onEvent)
            }
        }
    }
}
```

> **Pitfall:** Do not use `SharedFlow(replay = 0)` for navigation. If the event is emitted while the app is in the background, nobody is subscribed and the event is gone forever.

> **Interview:** A strong answer: "Google recommends modelling events as state with a consumed callback because state cannot be lost. If I use an effect stream, I use a buffered Channel collected with repeatOnLifecycle on Main.immediate, and I never use replay for one-off events."

## MVI in Depth

### The parts

- **Intent (or Action):** a typed description of something that happened. Usually a sealed interface. Examples: `QueryChanged("kot")`, `RetryClicked`.
- **Model (State):** one immutable data class that fully describes the screen.
- **Reducer:** a pure function `(State, Action) -> State`. No I/O, no coroutines, no randomness, no clock.
- **Side effects:** work that is not pure: network calls, database writes, timers. Their results come back in as new actions.
- **Effects (or Events, or Labels):** one-off outputs to the UI, such as navigation or a toast.

### The unidirectional loop

```text
          +-----------------------------------------+
          |                                         |
          v                                         |
   +-------------+   Action    +-------------+      |
   |     UI      | ----------> |   Store /   |      |
   | (Compose)   |             |  ViewModel  |      |
   +-------------+             +-------------+      |
          ^                       |        |        |
          |  State                |        | Action |
          |                       v        v        |
          |              +-----------+  +--------------+
          +------------- |  Reducer  |  | Side effects | --> Effect (nav, toast)
                         |  (pure)   |  | (repo, I/O)  |
                         +-----------+  +--------------+
                                              |
                                  result as a new Action
```

The UI never changes state. It only sends actions. The reducer is the only place that produces new state. Side effects run outside the reducer and report back by dispatching more actions.

### Why a pure reducer matters

```kotlin
fun reduce(state: CounterState, action: CounterAction): CounterState =
    when (action) {
        CounterAction.Increment -> state.copy(count = state.count + 1)
        CounterAction.Decrement -> state.copy(count = state.count - 1)
        CounterAction.Reset -> CounterState()
    }
```

- You can test it with plain function calls. No coroutines, no fakes.
- Same input always gives the same output, so bugs are reproducible.
- You can log every `(action, oldState, newState)` triple. Replaying the actions from a log rebuilds the exact state. This is the idea behind "time-travel debugging".

> **Pitfall:** Calling a repository, reading `System.currentTimeMillis()`, or launching a coroutine inside the reducer breaks purity. Move these into side-effect handlers and pass their results in as actions.

### Public vs internal actions

A clean pattern is to separate actions the UI can send from internal results.

- UI actions: `QueryChanged`, `Retry`, `ResultClicked`.
- Internal results (sometimes called mutations or partial states): `SearchStarted`, `SearchSucceeded`, `SearchFailed`.

Both go through the same reducer. Only the UI ones are part of the public API. Some teams use two sealed types to make this explicit.

## Worked Example: Search in MVVM

The feature: a search screen. The user types. After a 300 ms pause, the app searches. It shows loading, results, an empty message, or an error with Retry. Tapping a result opens a detail screen. The query must survive process death.

### Data layer

```kotlin
data class Item(val id: String, val title: String)

interface SearchRepository {
    suspend fun search(query: String): List<Item>
}

class DefaultSearchRepository @Inject constructor(
    private val api: SearchApi,
    @IoDispatcher private val io: CoroutineDispatcher,
) : SearchRepository {
    override suspend fun search(query: String): List<Item> =
        withContext(io) { api.search(query).map { it.toItem() } }
}
```

### UI state

```kotlin
data class SearchUiState(
    val query: String = "",
    val results: SearchResults = SearchResults.Idle,
)

sealed interface SearchResults {
    data object Idle : SearchResults
    data object Loading : SearchResults
    data object Empty : SearchResults
    data class Success(val items: List<Item>) : SearchResults
    data class Error(val message: String) : SearchResults
}
```

The `query` is separate from the results so the text field updates instantly while results are debounced.

### ViewModel

```kotlin
@OptIn(FlowPreview::class, ExperimentalCoroutinesApi::class)
@HiltViewModel
class SearchViewModel @Inject constructor(
    private val repository: SearchRepository,
    private val savedStateHandle: SavedStateHandle,
) : ViewModel() {

    private val query = savedStateHandle.getStateFlow(KEY_QUERY, "")
    private val retryTrigger = MutableStateFlow(0)

    private val results: Flow<SearchResults> =
        combine(query.debounce(300), retryTrigger) { q, _ -> q }
            .flatMapLatest { q -> searchFlow(q) }

    val uiState: StateFlow<SearchUiState> =
        combine(query, results) { q, r -> SearchUiState(q, r) }
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), SearchUiState())

    fun onQueryChange(newQuery: String) { savedStateHandle[KEY_QUERY] = newQuery }
    fun onRetry() { retryTrigger.update { it + 1 } }

    private companion object { const val KEY_QUERY = "query" }
}
```

`flatMapLatest` cancels the previous search when a new query arrives, so a slow old response can never overwrite a newer one.

### The search flow

```kotlin
private fun searchFlow(query: String): Flow<SearchResults> = flow {
    if (query.isBlank()) {
        emit(SearchResults.Idle)
        return@flow
    }
    emit(SearchResults.Loading)
    try {
        val items = repository.search(query.trim())
        emit(if (items.isEmpty()) SearchResults.Empty else SearchResults.Success(items))
    } catch (e: CancellationException) {
        throw e
    } catch (e: IOException) {
        emit(SearchResults.Error("Check your connection and try again"))
    }
}
```

> **Pitfall:** `runCatching { }` around a suspend call also catches `CancellationException`, which breaks structured concurrency. Either rethrow it, as above, or catch only the exception types you expect.

### Compose UI

```kotlin
@Composable
fun SearchRoute(
    onOpenItem: (String) -> Unit,
    viewModel: SearchViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    SearchScreen(
        uiState = uiState,
        onQueryChange = viewModel::onQueryChange,
        onRetry = viewModel::onRetry,
        onItemClick = onOpenItem,
    )
}
```

Navigation on click needs no ViewModel round trip here, so the UI calls `onOpenItem` directly.

```kotlin
@Composable
fun SearchScreen(
    uiState: SearchUiState,
    onQueryChange: (String) -> Unit,
    onRetry: () -> Unit,
    onItemClick: (String) -> Unit,
) {
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        OutlinedTextField(
            value = uiState.query,
            onValueChange = onQueryChange,
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("Search") },
        )
        when (val r = uiState.results) {
            SearchResults.Idle -> Text("Type to search")
            SearchResults.Loading -> CircularProgressIndicator()
            SearchResults.Empty -> Text("No results")
            is SearchResults.Error -> ErrorRow(r.message, onRetry)
            is SearchResults.Success -> LazyColumn {
                items(r.items, key = { it.id }) { item ->
                    Text(item.title, Modifier.clickable { onItemClick(item.id) })
                }
            }
        }
    }
}
```

> **Note:** Storing text field state in a `StateFlow` and writing it back on every keystroke works, but keep the update synchronous. If the update goes through an async pipeline before reaching the field, the cursor can jump. Newer Compose versions also offer `TextFieldState` as an alternative model for text input.

## Worked Example: Search in MVI

Same feature, MVI style. The UI sends actions, a reducer builds state, and side effects run separately.

### Contract

```kotlin
data class SearchState(
    val query: String = "",
    val isLoading: Boolean = false,
    val items: List<Item> = emptyList(),
    val error: String? = null,
) {
    val isEmpty: Boolean get() =
        query.isNotBlank() && !isLoading && error == null && items.isEmpty()
}

sealed interface SearchAction {
    // From the UI
    data class QueryChanged(val query: String) : SearchAction
    data object Retry : SearchAction
    data class ResultClicked(val id: String) : SearchAction
    // Internal results
    data object SearchStarted : SearchAction
    data class SearchSucceeded(val items: List<Item>) : SearchAction
    data class SearchFailed(val message: String) : SearchAction
}

sealed interface SearchEffect {
    data class NavigateToDetail(val id: String) : SearchEffect
}
```

> **Pitfall:** In this version `isEmpty` is true for a moment after the user types, before the debounce fires and loading starts. The MVVM version avoids this because its `Idle` and `Loading` are explicit cases. A real app might add a `isPending` flag or set loading on `QueryChanged`. Small details like this are good discussion points in interviews.

### Reducer

```kotlin
fun reduce(state: SearchState, action: SearchAction): SearchState = when (action) {
    is SearchAction.QueryChanged ->
        if (action.query.isBlank()) SearchState(query = action.query)
        else state.copy(query = action.query, error = null)
    SearchAction.SearchStarted ->
        state.copy(isLoading = true, error = null)
    is SearchAction.SearchSucceeded ->
        state.copy(isLoading = false, items = action.items)
    is SearchAction.SearchFailed ->
        state.copy(isLoading = false, error = action.message)
    SearchAction.Retry, is SearchAction.ResultClicked -> state
}
```

Note the reducer is a top-level pure function. It knows nothing about coroutines or repositories.

### ViewModel (store)

```kotlin
@HiltViewModel
class SearchMviViewModel @Inject constructor(
    private val repository: SearchRepository,
    private val savedStateHandle: SavedStateHandle,
) : ViewModel() {

    private val _state = MutableStateFlow(
        SearchState(query = savedStateHandle[KEY_QUERY] ?: "")
    )
    val state: StateFlow<SearchState> = _state.asStateFlow()

    private val _effects = Channel<SearchEffect>(Channel.BUFFERED)
    val effects: Flow<SearchEffect> = _effects.receiveAsFlow()

    private var searchJob: Job? = null

    init { if (_state.value.query.isNotBlank()) search(_state.value.query, 0) }

    fun dispatch(action: SearchAction) {
        _state.update { reduce(it, action) }
        handleSideEffects(action)
    }

    private companion object { const val KEY_QUERY = "query" }
}
```

`dispatch` is the single entry point. Because it runs on the main thread and `update` is atomic, actions are applied one at a time.

### Side effects

```kotlin
private fun handleSideEffects(action: SearchAction) {
    when (action) {
        is SearchAction.QueryChanged -> {
            savedStateHandle[KEY_QUERY] = action.query
            search(action.query, debounceMs = 300)
        }
        SearchAction.Retry -> search(_state.value.query, debounceMs = 0)
        is SearchAction.ResultClicked ->
            viewModelScope.launch { _effects.send(SearchEffect.NavigateToDetail(action.id)) }
        else -> Unit
    }
}

private fun search(query: String, debounceMs: Long) {
    searchJob?.cancel()
    if (query.isBlank()) return
    searchJob = viewModelScope.launch {
        delay(debounceMs)            // cancel-and-restart = debounce
        dispatch(SearchAction.SearchStarted)
        try {
            dispatch(SearchAction.SearchSucceeded(repository.search(query.trim())))
        } catch (e: IOException) {
            dispatch(SearchAction.SearchFailed("Check your connection and try again"))
        }
    }
}
```

Cancelling the previous job on every new query gives both debounce and "latest wins" behaviour. A `CancellationException` is not an `IOException`, so it is not swallowed.

### Compose UI

```kotlin
@Composable
fun SearchMviRoute(
    onOpenItem: (String) -> Unit,
    viewModel: SearchMviViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    ObserveAsEvents(viewModel.effects) { effect ->
        when (effect) {
            is SearchEffect.NavigateToDetail -> onOpenItem(effect.id)
        }
    }

    SearchMviScreen(state = state, onAction = viewModel::dispatch)
}
```

The screen takes a single `onAction: (SearchAction) -> Unit` lambda instead of one lambda per event. Inside it you write `onAction(SearchAction.QueryChanged(it))` and so on.

> **Tip:** In this example routing the click through an effect is only to show the pattern. If the click needs no logic (no analytics, no validation), calling `onOpenItem` directly from the UI is simpler and is what Google's guidance suggests.

### What changed between the two versions

- MVVM: several public functions, state derived reactively with `combine` and `flatMapLatest`.
- MVI: one `dispatch` function, a pure reducer, explicit internal actions, and a separate effect stream.
- Both: one immutable state, `StateFlow`, unidirectional flow, `SavedStateHandle` for the query, latest-wins search.

## MVVM vs MVI

| Aspect | MVVM (Google style) | MVI |
|---|---|---|
| UI to ViewModel | Plain functions like `onRetry()` | One `dispatch(action)` with a sealed type |
| State | Often one `UiState`, sometimes several streams | Always one immutable state |
| State changes | Anywhere in the ViewModel via `update` | Only in the reducer |
| Boilerplate | Low | Higher (actions, effects, reducer) |
| Debuggability | Good with discipline | Very good, every change has a named action |
| Time-travel debugging | Not natural | Possible by replaying logged actions |
| Concurrency | Flow operators handle it well | Must ensure actions are processed in order |
| Testability | Test via public functions and state | Reducer is trivially testable, plus ViewModel tests |
| Learning curve | Lower, matches official docs | Steeper, more concepts |
| Best for | Most screens, small teams, CRUD | Complex screens with many interacting events |

> **Interview:** There is no single right answer. Say what you would pick and why: "MVVM with a single UiState and UDF by default, because it is what the official docs describe and has less ceremony. I move to MVI on complex screens, like a multi-step checkout, where a strict reducer and a log of actions pay for themselves."

### Concurrency notes

- In MVI, if actions are processed from multiple coroutines, two reducers could race. Using `update` keeps each reduction atomic. Some libraries also queue actions through a `Channel` so they run strictly in order.
- In MVVM, `combine`, `flatMapLatest`, and `stateIn` handle most concurrency for you. The common bug is forgetting `flatMapLatest` (using `flatMapConcat` or `map` with launched jobs), which lets old responses overwrite new ones.

## Loading, Error, Empty and Paging

### Model every state on purpose

Every data screen has at least five states: initial or idle, loading, content, empty, and error. Many have more: refreshing with content visible, partial error (content shown with a snackbar), and offline.

```kotlin
data class FeedUiState(
    val items: List<FeedItemUi> = emptyList(),
    val isInitialLoading: Boolean = true,
    val isRefreshing: Boolean = false,
    val errorMessage: String? = null,
) {
    val showEmpty: Boolean get() =
        !isInitialLoading && errorMessage == null && items.isEmpty()
    val showFullScreenError: Boolean get() =
        errorMessage != null && items.isEmpty()
}
```

Rules of thumb:

- If you already have content, keep showing it during refresh. Show the error as a snackbar, not a full-screen error.
- Full-screen error only when there is nothing to show.
- Never show a spinner and an error at the same time. A sealed type or derived properties prevent this.
- Map exceptions to user-friendly messages (or string resource ids) in the ViewModel, not in the composable.

> **Tip:** Avoid hard-coded strings in the ViewModel when you need localization. Expose a `@StringRes Int` or a small `UiText` sealed type and resolve it in the UI, because the ViewModel should not hold a `Context`.

### A generic Result wrapper

Some codebases wrap flows in a small result type so loading and error are handled the same way everywhere. Now in Android uses this idea.

```kotlin
sealed interface Result<out T> {
    data class Success<T>(val data: T) : Result<T>
    data class Error(val exception: Throwable) : Result<Nothing>
    data object Loading : Result<Nothing>
}

fun <T> Flow<T>.asResult(): Flow<Result<T>> = map<T, Result<T>> { Result.Success(it) }
    .onStart { emit(Result.Loading) }
    .catch { emit(Result.Error(it)) }
```

### Pagination basics

For simple "load more" you can keep a page number and an `isLoadingMore` flag in state, and append results in the reducer or `update`. For real infinite lists, use **Paging 3**.

- `PagingSource` loads one page from one source. `RemoteMediator` handles network plus database for offline-first paging.
- `Pager(...).flow` gives `Flow<PagingData<T>>`.
- In the ViewModel, call `.cachedIn(viewModelScope)` so the paged data survives config changes.
- In Compose, use `collectAsLazyPagingItems()` and read `loadState` for loading and error at the top and bottom of the list.

```kotlin
val feed: Flow<PagingData<FeedItem>> = Pager(
    config = PagingConfig(pageSize = 20),
    pagingSourceFactory = { repository.feedPagingSource() },
).flow.cachedIn(viewModelScope)
```

> **Pitfall:** Do not put `PagingData` inside your `UiState` data class. It is a stream with its own lifecycle. Expose it as a separate `Flow` next to your `StateFlow<UiState>`.

## DI and Modularization

### How Hilt fits

The ViewModel asks for interfaces. Hilt modules decide which implementation to provide.

```kotlin
@Module
@InstallIn(SingletonComponent::class)
abstract class DataModule {
    @Binds
    @Singleton
    abstract fun bindSearchRepository(impl: DefaultSearchRepository): SearchRepository
}

@Module
@InstallIn(SingletonComponent::class)
object DispatchersModule {
    @Provides
    @IoDispatcher
    fun provideIoDispatcher(): CoroutineDispatcher = Dispatchers.IO
}
```

- Use `@Binds` to map an interface to an implementation. Use `@Provides` for things you cannot construct with `@Inject`, like Retrofit or Room.
- Inject dispatchers instead of hard-coding `Dispatchers.IO`. Tests can then pass a test dispatcher.

### Scopes that matter here

| Component | Scope annotation | Lives as long as |
|---|---|---|
| `SingletonComponent` | `@Singleton` | The Application |
| `ActivityRetainedComponent` | `@ActivityRetainedScoped` | Activity, across config changes |
| `ViewModelComponent` | `@ViewModelScoped` | One ViewModel instance |
| `ActivityComponent` | `@ActivityScoped` | One Activity instance |

Repositories that hold caches or shared state are usually `@Singleton`. A helper that should be shared only by the ViewModel and its use cases can be `@ViewModelScoped`. Unscoped bindings create a new instance per injection, which is fine and cheap for stateless classes.

> **Pitfall:** Scoping everything as `@Singleton` "to be safe" keeps objects in memory forever and hides bad dependencies. Scope only what must share state.

### Modularization basics

Large apps split code into Gradle modules. Google's [Now in Android](https://github.com/android/nowinandroid) sample is the usual reference.

```text
app/                    -> wires features together, navigation host
feature/search/         -> SearchViewModel, SearchScreen
feature/detail/
core/model/             -> plain Kotlin data classes
core/data/              -> repositories
core/domain/            -> use cases (optional)
core/database/          -> Room
core/network/           -> Retrofit
core/designsystem/      -> theme, shared components
core/testing/           -> fakes, MainDispatcherRule
```

- **Feature modules** depend on core modules, never on each other.
- **api/impl split:** a feature can expose a small `:feature:search:api` module (navigation route, public interfaces) and keep the code in `:feature:search:impl`. Other features depend only on the api module. This reduces rebuilds and hides internals.
- Benefits: faster incremental builds, clear ownership, enforced boundaries, and the ability to use `internal` visibility.
- Convention plugins in an included `build-logic` build keep Gradle config consistent across modules.

## Testing ViewModels

### The setup

ViewModels use `viewModelScope`, which runs on `Dispatchers.Main`. JVM tests have no main looper, so you replace Main with a test dispatcher.

```kotlin
class MainDispatcherRule(
    val testDispatcher: TestDispatcher = UnconfinedTestDispatcher(),
) : TestWatcher() {
    override fun starting(description: Description) {
        Dispatchers.setMain(testDispatcher)
    }
    override fun finished(description: Description) {
        Dispatchers.resetMain()
    }
}
```

When `Dispatchers.Main` is set to a `TestDispatcher`, `runTest` shares its scheduler, so virtual time (`advanceTimeBy`, `advanceUntilIdle`) also controls `delay` and `debounce` inside the ViewModel.

### Fakes over mocks

Google recommends fakes for repositories. A fake is a small working implementation that you control.

```kotlin
class FakeSearchRepository : SearchRepository {
    var results: List<Item> = emptyList()
    var error: IOException? = null
    val queries = mutableListOf<String>()

    override suspend fun search(query: String): List<Item> {
        queries += query
        error?.let { throw it }
        return results
    }
}
```

Why fakes: tests read like real usage, they do not break when you change call order, and you can reuse them across many tests. Mocks (MockK, Mockito) are fine for checking one interaction, but heavy mocking couples tests to implementation details.

### Testing a reducer

```kotlin
@Test
fun `blank query resets state`() {
    val start = SearchState(query = "kot", items = listOf(Item("1", "Kotlin")))
    val result = reduce(start, SearchAction.QueryChanged(""))
    assertEquals(SearchState(query = ""), result)
}
```

No coroutines and no rules needed. This is the biggest testing win of MVI.

### Testing a ViewModel with Turbine

```kotlin
class SearchMviViewModelTest {
    @get:Rule val mainRule = MainDispatcherRule(StandardTestDispatcher())
    private val repo = FakeSearchRepository()

    @Test
    fun `typing then waiting shows results`() = runTest {
        repo.results = listOf(Item("1", "Kotlin"))
        val vm = SearchMviViewModel(repo, SavedStateHandle())

        vm.state.test {
            assertEquals(SearchState(), awaitItem())
            vm.dispatch(SearchAction.QueryChanged("kot"))
            assertEquals("kot", awaitItem().query)
            advanceTimeBy(301)
            runCurrent()
            // Loading may be conflated away, so check the latest state
            assertEquals(repo.results, expectMostRecentItem().items)
            cancelAndIgnoreRemainingEvents()
        }
        assertEquals(listOf("kot"), repo.queries)
    }
}
```

[Turbine](https://github.com/cashapp/turbine) gives `test { awaitItem() }` for flows. It fails the test if an item does not arrive or if unconsumed events remain.

> **Pitfall:** `StateFlow` conflates. If two updates happen without a suspension point between them, a collector may only see the last one. With `UnconfinedTestDispatcher` intermediate states can be skipped or seen differently than with `StandardTestDispatcher`. Assert on the states you care about, not on every frame.

### Testing stateIn with WhileSubscribed

A `stateIn(WhileSubscribed)` flow does nothing until someone collects it. Start a collector in `backgroundScope`.

```kotlin
@Test
fun `results appear after debounce`() = runTest {
    repo.results = listOf(Item("1", "Kotlin"))
    val vm = SearchViewModel(repo, SavedStateHandle())
    backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
        vm.uiState.collect()
    }
    vm.onQueryChange("kot")
    advanceTimeBy(301)
    runCurrent()
    assertEquals(SearchResults.Success(repo.results), vm.uiState.value.results)
}
```

`backgroundScope` is cancelled automatically at the end of `runTest`, so the infinite collector does not hang the test.

> **Tip:** Test the stateless `Screen` composable separately with `createComposeRule()` and a hand-made `UiState`. You do not need a ViewModel for UI tests of rendering.

## Anti-patterns and Libraries

### Common anti-patterns

- **Holding a Context, View, or Activity in a ViewModel.** The ViewModel outlives the Activity, so this leaks it. If you truly need the app context, use `AndroidViewModel` sparingly, or better, inject a wrapper (for example a `StringProvider` or a repository) that uses the application context.
- **Exposing `MutableStateFlow` publicly.** Anyone can then change the state, which breaks the single source of truth. Expose `StateFlow` via `asStateFlow()`.
- **Business logic in composables.** Filtering, sorting, validation, or calling repositories from a composable makes it hard to test and runs again on recomposition. Put it in the ViewModel or a use case.
- **God ViewModels.** One ViewModel for a whole app or a huge screen with thousands of lines. Split by screen, extract use cases, or use plain state holder classes for parts of the UI.
- **Sharing one ViewModel between unrelated screens** as a "data bus". Share data through a repository instead. Sharing a ViewModel scoped to a nav graph is fine for a true multi-step flow.
- **`LiveData` in the domain or data layer.** `LiveData` is a lifecycle-aware UI type tied to the main thread. Use `Flow` and `suspend` below the UI layer.
- **Passing a ViewModel down into child composables.** Pass state and lambdas instead. Child composables become reusable and previewable.
- **Launching collection in `init` with `collect` and copying into a `MutableStateFlow`** when `stateIn` would do. This keeps the upstream alive forever even when nobody is looking.
- **Swallowing `CancellationException`** with `catch (e: Exception)` or `runCatching`.
- **Using `GlobalScope`** for screen work. It is not cancelled when the screen goes away.
- **Mutable collections in state** (`MutableList` in a data class). Compose cannot detect changes, and state can change behind your back.

> **Pitfall:** Calling `viewModel.loadData()` from a `LaunchedEffect(Unit)` triggers a reload after every configuration change, because the effect runs again in the new composition. Start the load from the ViewModel itself (in `init`, or lazily via `stateIn`).

### Libraries worth knowing by name

- **Orbit MVI:** a lightweight Kotlin MVI library built around a `container` with `intent { }`, `reduce { }` and `postSideEffect()`.
- **Mavericks:** Airbnb's MVI framework with `MavericksViewModel`, immutable `MavericksState`, and `setState { copy(...) }`.
- **Circuit:** Slack's Compose-first architecture that splits each screen into a `Presenter` (a composable that produces state) and a `Ui`.
- **Molecule:** Cash App's library that builds a `StateFlow` from a `@Composable` function, so you can write presenter logic with Compose runtime instead of Flow operators.

## Interview Questions

### Q: How does a ViewModel survive a configuration change?

It lives in a `ViewModelStore` owned by the Activity, Fragment, or back stack entry. During a config change, `ComponentActivity` keeps the store through `onRetainNonConfigurationInstance()` and hands it to the new Activity. On destroy it checks `isChangingConfigurations`; only when the Activity is finishing for good does it clear the store and call `onCleared()`.

### Q: Does a ViewModel survive process death? How do you handle it?

No. The whole process is gone. Save small, critical UI state in `SavedStateHandle` (or `rememberSaveable` in Compose for UI-element state). On restore, reload large data from the repository using the saved ids. Test it with `adb shell am kill`.

### Q: What is unidirectional data flow?

State flows down from the data layer through the ViewModel to the UI. Events flow up from the UI to the ViewModel. The UI never mutates state directly. This gives one source of truth per screen and makes changes predictable.

### Q: StateFlow vs SharedFlow vs LiveData?

`StateFlow` always has a value, replays the latest value to new collectors, and skips equal values. It is the default for UI state. `SharedFlow` is configurable (replay, buffer) and has no initial value; it suits event streams. `LiveData` is lifecycle-aware and main-thread only; it is still supported, but Kotlin-first code uses `StateFlow` with lifecycle-aware collection.

### Q: Why WhileSubscribed(5000) in stateIn?

It keeps the upstream alive for 5 seconds after the last collector leaves. That covers a configuration change, so data is not reloaded on rotation. When the app stays in the background longer, the upstream stops and saves resources.

### Q: How do you handle one-off events like navigation or snackbars?

Google's guidance is to model them as state (for example `userMessage: String?`) and have the UI call back when it has handled it. If a team uses an effect stream, use a buffered `Channel` with `receiveAsFlow()`, collected with `repeatOnLifecycle` on `Dispatchers.Main.immediate`. Avoid `SharedFlow` with replay for one-off events.

### Q: What is a reducer and why must it be pure?

A reducer is a function `(State, Action) -> State`. Pure means no side effects and same input gives same output. That makes it trivially testable, makes bugs reproducible, and allows logging or replaying actions to rebuild state.

### Q: Where do side effects go in MVI?

Outside the reducer, in a side-effect handler or middleware inside the ViewModel. It reacts to actions, does I/O in `viewModelScope`, and dispatches result actions (success or failure) back to the reducer. One-off UI outputs go to an effect stream.

### Q: When would you add a domain layer?

When business logic is reused across several ViewModels, or when combining multiple repositories gets complex enough to deserve its own tested class. It is optional. Use cases that only forward a single repository call add noise.

### Q: Single UiState or multiple flows?

Default to a single immutable `UiState` because it is always consistent and easy to test. Split into multiple flows only for parts that are truly independent and update at different rates, and keep paged data as its own flow.

### Q: How do you inject a ViewModel's dependencies without Hilt?

Use a `ViewModelProvider.Factory`, usually built with the `viewModelFactory { initializer { } }` DSL. It reads values from `CreationExtras`, such as the `Application` via `APPLICATION_KEY`, and creates a `SavedStateHandle` with `createSavedStateHandle()`.

### Q: Why shouldn't a ViewModel hold a Context?

The ViewModel outlives the Activity, so holding an Activity or View context leaks it after rotation. It also makes the ViewModel harder to unit test. Move Context-dependent work into the data layer or an injected wrapper that uses the application context.

### Q: How do you test a ViewModel that uses viewModelScope and debounce?

Replace `Dispatchers.Main` with a test dispatcher using a `MainDispatcherRule`. Use `runTest`, which shares the Main test dispatcher's scheduler, and control virtual time with `advanceTimeBy` or `advanceUntilIdle`. Use fake repositories and Turbine to assert emitted states. For `stateIn(WhileSubscribed)`, start a collector in `backgroundScope`.

### Q: How do you prevent an old search result from overwriting a newer one?

Use `flatMapLatest` (or `collectLatest`, or cancel the previous `Job`) so starting a new search cancels the old one. Then a slow response for an outdated query can never be applied.

### Q: MVVM or MVI for a new app?

Explain the trade-off rather than picking a winner. Google-style MVVM with a single `UiState` and UDF is the default and has less boilerplate. MVI adds strict reducers, typed actions, and better traceability, which pays off on complex, event-heavy screens or in teams that want one strict convention everywhere.

### Q: What is the difference between UI state held in a ViewModel and in rememberSaveable?

ViewModel state is screen-level and business-related: data loaded from repositories, results of logic. `rememberSaveable` is for UI-element state such as whether a dropdown is expanded or the text in a local field. Both can survive process death if saved, but ViewModel state uses `SavedStateHandle` and composable state uses `rememberSaveable`.

## Cheat Sheet, Practice and References

### One-screen cheat sheet

- Layers: UI (composables + ViewModel), optional domain (use cases), data (repositories + data sources). Dependencies point down.
- UDF: state down, events up. One source of truth per piece of data.
- ViewModel: survives config change, not process death. Lives in `ViewModelStore`. Cleared via `onCleared()`.
- `viewModelScope`: `SupervisorJob` + `Main.immediate`, cancelled on clear.
- `SavedStateHandle`: small Bundle-friendly state, `getStateFlow(key, default)`, survives process death.
- Hilt: `@HiltViewModel` + `@Inject constructor`, `hiltViewModel()` in Compose.
- State: one immutable `UiState`. Private `MutableStateFlow`, public `StateFlow`. Change with `update { }`.
- Derived state: `combine(...)` + `stateIn(viewModelScope, WhileSubscribed(5_000), initial)`.
- Collect: `collectAsStateWithLifecycle()` in Compose, `repeatOnLifecycle(STARTED)` in Views.
- Events: prefer state + "shown" callback. Else buffered `Channel` + `receiveAsFlow()`.
- Search: `debounce` + `flatMapLatest`. Rethrow `CancellationException`.
- MVI: Action -> reducer `(State, Action) -> State` -> State. Side effects outside, results come back as actions.
- Paging: `Pager(...).flow.cachedIn(viewModelScope)`, separate from `UiState`.
- Testing: `MainDispatcherRule`, `runTest`, fakes, Turbine, `backgroundScope` collector for `stateIn`.
- Never: Context in ViewModel, public MutableStateFlow, logic in composables, LiveData below UI, GlobalScope.

### Practice exercises

1. Build a login screen with email and password in Google-style MVVM. Use one `UiState`, validate on the fly, show a loading button, and show an error snackbar using the "event as state" pattern. Make the email survive process death and verify it with `adb shell am kill`.
2. Re-implement the same login screen in MVI with a sealed `LoginAction`, a pure reducer, and a `LoginEffect` for navigation. Write at least five reducer tests with no coroutines.
3. Take the MVVM search example and add a "recent searches" list stored in Room. Combine it with the search results so recent searches show when the query is blank. Write a Turbine test with a fake repository.
4. Add Paging 3 to a feed screen. Show a full-screen loader on first load, an inline retry footer on append error, and an empty state. Keep `PagingData` out of the `UiState`.
5. Split a small app into modules: `:app`, `:feature:search`, `:feature:detail`, `:core:data`, `:core:model`, `:core:testing`. Make sure the two features do not depend on each other, and put `MainDispatcherRule` and fakes in `:core:testing`.

### References

- [Guide to app architecture](https://developer.android.com/topic/architecture)
- [UI layer](https://developer.android.com/topic/architecture/ui-layer)
- [UI events](https://developer.android.com/topic/architecture/ui-layer/events)
- [State holders and UI state](https://developer.android.com/topic/architecture/ui-layer/stateholders)
- [Domain layer](https://developer.android.com/topic/architecture/domain-layer)
- [Data layer](https://developer.android.com/topic/architecture/data-layer)
- [Build an offline-first app](https://developer.android.com/topic/architecture/data-layer/offline-first)
- [Architecture recommendations](https://developer.android.com/topic/architecture/recommendations)
- [ViewModel overview](https://developer.android.com/topic/libraries/architecture/viewmodel)
- [Saved State module for ViewModel](https://developer.android.com/topic/libraries/architecture/viewmodel/viewmodel-savedstate)
- [ViewModel factories and CreationExtras](https://developer.android.com/topic/libraries/architecture/viewmodel/viewmodel-factories)
- [StateFlow and SharedFlow](https://developer.android.com/kotlin/flow/stateflow-and-sharedflow)
- [Hilt and Jetpack integrations](https://developer.android.com/training/dependency-injection/hilt-jetpack)
- [Testing Kotlin coroutines on Android](https://developer.android.com/kotlin/coroutines/test)
- [Paging library overview](https://developer.android.com/topic/libraries/architecture/paging/v3-overview)
- [Guide to Android app modularization](https://developer.android.com/topic/modularization)
- [Now in Android sample](https://github.com/android/nowinandroid)
- [Turbine](https://github.com/cashapp/turbine)
