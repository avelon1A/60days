## Why architecture

Why Android screens need a plan, and how MVC, MVP, MVVM and MVI each fixed the pain of the one before.

:::tldr
- Architecture solves real Android problems: config changes, process death, async work and testability.
- A ViewModel survives rotation but not process death; small state needs `SavedStateHandle`.
- MVC led to MVP, then MVVM, then MVI; each pattern reacted to the last one's pain.
:::

### The problem

An Android screen is hard to get right. The system can destroy and recreate your Activity at any time. The user can rotate the phone, switch to dark mode or resize a window.

The OS can also kill your whole process while the app is in the background. Network calls are slow and can fail. Without a plan, all of this ends up tangled inside one Activity.

### What good architecture gives you

- **Separation of concerns.** UI code draws pixels. Business logic decides what to show. Data code fetches and stores. Each part changes for its own reasons.
- **Testability.** Logic that does not touch `Context` or Views runs in fast JVM unit tests, without an emulator.
- **Surviving configuration changes.** State held in a `ViewModel` survives rotation, so you do not re-fetch data.
- **Surviving process death.** Small critical state (a search query, a selected tab) is saved with `SavedStateHandle`.

It also gives a team a shared language. When every screen has the same shape, a new developer knows where to look.

> **Interview:** For "why do we need architecture?", name concrete Android problems: config changes, process death, lifecycle-aware async work and testability. "Clean code" alone sounds junior.

### Config change vs process death

These two are often confused, so be precise.

| Event | Destroyed | Survives | Tool |
|---|---|---|---|
| Config change (rotation, theme, locale) | Activity and its UI | ViewModel instances | `ViewModel` |
| Process death (low memory in background) | Whole process, all ViewModels | Saved instance state Bundle | `SavedStateHandle`, `rememberSaveable` |
| User finishes the screen (back) | Activity and ViewModel | Nothing for that screen | Persistent storage |

> **Pitfall:** A ViewModel does NOT survive process death. Keep the query only in a `MutableStateFlow` and the user returns to an empty screen.

### MVC: the massive Activity

Early Android apps used the Activity as both View and Controller. It inflated layouts, handled clicks, called the network and parsed results. Nothing was testable without a device, and rotation lost in-flight work.

### MVP: logic moves out

MVP pulled logic into a `Presenter`. The Activity implemented a `View` interface with calls like `showLoading()` and `showUsers(list)`.

- Solved: logic lived in a plain class, testable with a mocked View.
- New pain: the Presenter held a View reference, so you had to attach and detach it to avoid leaks. It did not survive rotation by default. UI state was spread across many imperative calls, so a spinner and an error could show at once.

### MVVM: the dependency flips

The ViewModel does not know the View. It exposes observable state, and the View observes it. Google's Architecture Components (2017) shipped `ViewModel` and `LiveData`, making MVVM the Android default.

- Solved: no View reference, so no leaks. The ViewModel survives config changes.
- New pain: teams exposed many streams (`isLoading`, `error`, `items`) that could disagree. One-off events were awkward with `LiveData` (the `SingleLiveEvent` hack).

### MVI: strict one-way flow

MVI came from the web (Cycle.js, Redux, Elm). It adds rules on top of MVVM: one immutable state per screen, all input as typed intents, and state changed only by a reducer.

- Solved: one source of truth for the screen, and every change has a named cause.
- Cost: more boilerplate (sealed types for intents, effects and results).

> **Note:** Modern Google-style MVVM already borrows most of MVI: a single `UiState`, immutable data and unidirectional data flow. The main difference left is typed intents through one entry point versus plain functions.

:::check
Q: A user types a query, rotates the phone, then backgrounds the app and the OS kills it. Which event loses a query held only in a `MutableStateFlow`?
A: Only the process kill. Rotation keeps the same ViewModel, but process death destroys it; the query needs `SavedStateHandle` to come back.
Q: Why could MVP show a loading spinner and an error at the same time, while a single-state MVVM screen cannot?
A: MVP builds the UI from many imperative calls, so a missed `hideLoading()` leaves stale UI. A single immutable state object describes the whole screen at once, so the combination must be modelled on purpose.
Q: Interview: What does a ViewModel solve that a Presenter did not?
A: It survives configuration changes through the `ViewModelStore` and holds no reference to the View, so there is nothing to attach, detach or leak. The UI observes its state instead of being told what to do.
:::

## Google's layered architecture

The three layers Google recommends, how data flows between them, and why the database should be the source of truth.

:::tldr
- Three layers: UI (composables plus ViewModel), an optional domain layer (use cases), and data (repositories plus data sources).
- In Google's guide, UI depends on domain and domain depends on data, never the other way.
- Unidirectional data flow: state flows down, events flow up; each piece of data has one owner.
:::

### The big picture

Google's [Guide to app architecture](https://developer.android.com/topic/architecture) recommends three layers. Dependencies point downward: UI to domain to data.

```text
+------------------------------------------+
| UI layer                                 |
|   UI elements (Compose / Views)          |
|   State holders (ViewModel)              |
+------------------------------------------+
           | calls        ^ state (Flow)
           v              |
+------------------------------------------+
| Domain layer (optional)                  |
|   Use cases: GetLatestNewsUseCase ...    |
+------------------------------------------+
           |              ^
           v              |
+------------------------------------------+
| Data layer                               |
|   Repositories -> data sources           |
|   (Room, Retrofit, DataStore)            |
+------------------------------------------+
```

### UI layer

The UI layer has two parts. **UI elements** render data (composables or Views). **State holders**, usually a `ViewModel`, hold state, apply screen logic and expose it.

The UI layer turns app data into UI state. For example, it maps a `User` into a `ProfileUiState` with formatted strings.

### Domain layer (optional)

The domain layer holds reusable business logic in **use cases**. Each use case does one thing. The naming convention is verb + noun + `UseCase`, like `GetLatestNewsWithAuthorsUseCase`.

Use cases are usually called like functions through `operator fun invoke`.

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

Add a domain layer when logic is reused by several ViewModels, or when combining repositories gets complex. Do not add it to every screen by default.

### Data layer

The data layer holds **repositories** and **data sources**. A data source works with exactly one source: a Room DAO, a Retrofit API, DataStore. A repository combines data sources, resolves conflicts and exposes clean data.

- Expose `suspend` functions for one-shot work and `Flow` for data that changes over time.
- Name repositories after the data they own: `NewsRepository`, `UserRepository`.
- Make every public function **main-safe**. The repository or data source switches to `Dispatchers.IO` itself.

### Single source of truth and offline-first

Each piece of data has one owner, the **single source of truth (SSOT)**. Only the owner changes it. Everyone else gets an immutable view.

In an **offline-first** app, the local database is the SSOT. The network only refreshes the database. The UI observes the database through a `Flow`, so it always shows something, even offline.

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

When `refresh()` writes rows, Room re-emits `observeAll()`, and the UI updates on its own. Nobody pushes data to the screen by hand.

### Unidirectional data flow

**Unidirectional data flow (UDF)** ties the layers together. State flows down: data to ViewModel to UI. Events flow up: UI to ViewModel to data. The UI never mutates state directly.

> **Tip:** Google uses the term UDF throughout its docs. Use it in interviews.

:::deeper Main-safety in practice
A main-safe function can be called from `Dispatchers.Main` without blocking it. Room's `suspend` DAO functions and `Flow` queries are already main-safe. Retrofit's `suspend` functions are too.

Your own blocking work (parsing a large file, hashing) needs `withContext(ioDispatcher)` or `withContext(defaultDispatcher)`. Inject the dispatcher rather than hard-coding it, so tests can swap in a test dispatcher.
:::

:::check
Q: In an offline-first news app, the user pulls to refresh with no network. What does the screen show?
A: The cached articles from the database, because the UI observes the database, not the network. Only the refresh fails, which can be shown as a snackbar.
Q: A use case only calls `newsRepository.getNews()` and returns the result. Should you keep it?
A: Usually not. It adds a file and indirection with no logic. Google calls the domain layer optional; add a use case when there is real logic or reuse.
Q: Interview: What does "single source of truth" mean, and who is the SSOT in an offline-first app?
A: Each piece of data has exactly one owner that is allowed to change it, and everyone else reads an immutable view. In an offline-first app the local database is the SSOT; the network only writes into it.
:::

## Clean Architecture: circles and the Dependency Rule

What Uncle Bob's Clean Architecture is, the four circles, and the one rule that holds it together.

:::tldr
- Clean Architecture keeps business rules at the center and frameworks, databases and UI at the edges.
- Four circles: Entities, Use Cases, Interface Adapters, Frameworks and Drivers.
- The Dependency Rule: source code dependencies point only inward; inner layers own the interfaces.
:::

### What it is

Clean Architecture is a set of rules for organizing a whole app. Robert C. Martin ("Uncle Bob") described it in a 2012 blog post and his 2017 book *Clean Architecture*.

It pulls together older ideas such as Hexagonal Architecture (Ports and Adapters) and Onion Architecture. They share one goal: business rules at the center, details at the edges.

### The problem it solves

The problem is coupling. In many apps the business logic knows about Retrofit responses, Room entities and Android classes. Then an API change or a database migration forces edits deep in the logic.

Logic mixed with framework code is also hard to unit test. Clean Architecture aims for code that is:

- **Independent of frameworks.** Android, Room and Retrofit are tools, not the center.
- **Testable.** Business rules run without UI, database or network.
- **Independent of UI and database.** Swap Views for Compose, or Room for something else, without touching the rules.

### The concentric circles

Inner circles are policies (business rules). Outer circles are mechanisms (details).

```text
+---------------------------------------------------+
| Frameworks & Drivers                              |
|   Android SDK, Compose, Room, Retrofit            |
|  +---------------------------------------------+  |
|  | Interface Adapters                          |  |
|  |   ViewModels, repository impls, mappers     |  |
|  |  +---------------------------------------+  |  |
|  |  | Use Cases (application rules)         |  |  |
|  |  |   GetUserProfileUseCase               |  |  |
|  |  |  +---------------------------------+  |  |  |
|  |  |  | Entities (core business rules)  |  |  |  |
|  |  |  |   User, Order, Money            |  |  |  |
|  |  |  +---------------------------------+  |  |  |
|  |  +---------------------------------------+  |  |
|  +---------------------------------------------+  |
+---------------------------------------------------+
     Source code dependencies point INWARD only
```

- **Entities:** core business objects and rules. They would exist even without this app, like "an order total cannot be negative".
- **Use Cases:** rules specific to this app. They orchestrate entities for one task, like "place an order".
- **Interface Adapters:** convert data between what the inner circles want and what the outer tools want. ViewModels, presenters, repository implementations and mappers live here.
- **Frameworks and Drivers:** the outer details: UI toolkit, database, HTTP client, the OS.

Uncle Bob says four circles is not a rule. What matters is the direction of dependencies.

### The Dependency Rule

The one rule: **source code dependencies can only point inward**. Nothing in an inner circle may know anything about an outer circle. No class names, no functions, no data formats.

In practice:

- An entity never imports a use case, a ViewModel or a Room annotation.
- A use case never imports a Retrofit type, a DTO or `android.*`.
- Data crossing a boundary inward is converted into a simple form the inner circle owns.

### Control flow vs source dependencies

At runtime, control still flows outward. A use case calls a repository, which hits the network. How can the use case call outward without depending on outer code?

The use case depends only on an **interface it owns**. The outer layer implements that interface. This is the **Dependency Inversion Principle**: high-level policy and low-level detail both depend on an abstraction, and the abstraction belongs to the policy side.

```text
Runtime call:     UseCase  --->  RepositoryImpl  --->  Retrofit
Source imports:   UseCase  --->  Repository (interface, inner)
                                     ^
                  RepositoryImpl ----+  (outer implements inner)
```

The source arrow from the data code now points inward, even though the call goes outward.

> **Interview:** "The Dependency Rule says source code dependencies point only inward, toward higher-level policy. Runtime calls can go outward, but we invert those dependencies with interfaces owned by the inner layer."

:::deeper Ports and Adapters in one paragraph
Hexagonal Architecture names the same idea differently. A **port** is an interface the core defines, like `UserRepository`. An **adapter** is an outer implementation, like `UserRepositoryImpl` talking to Retrofit. "Driving" adapters (UI, tests) call into the core. "Driven" adapters (database, network) are called by the core through its ports. Clean Architecture's circles and Hexagonal's ports describe the same dependency direction.
:::

:::check
Q: A use case has `import retrofit2.HttpException` so it can check for 401. Which rule does this break, and what is the fix?
A: The Dependency Rule, because an inner circle now knows an outer framework. The data layer should translate the exception into a domain error, such as `DomainError.Unauthorized`, that the use case owns.
Q: At runtime the use case calls the repository implementation. Why is that not a violation?
A: The rule is about source code dependencies, not call direction. The use case only imports an interface it owns; the implementation in the outer layer depends on that interface.
Q: Interview: Explain the Dependency Rule and how Dependency Inversion makes it possible.
A: Source dependencies point only inward, so inner policy code never names outer details. When inner code must call outward, it defines an interface and the outer layer implements it, so the source arrow still points inward.
:::

## Clean Architecture in practice

How Clean Architecture maps onto an Android app with Hilt, how it differs from Google's guide, and when it is worth it.

:::tldr
- The domain owns `UserRepository`; data implements it; a Hilt `@Binds` wires them together.
- Google's guide has domain depending on data; Clean puts domain at the center with both sides pointing to it.
- Make the domain a pure Kotlin module so the compiler, not code review, enforces the boundary.
:::

### Dependency inversion with Hilt

The domain defines the interface it needs. The data layer implements it. DI connects them at runtime.

```kotlin
// :domain  (pure Kotlin)
interface UserRepository {
    suspend fun getUser(id: String): AppResult<User>
    fun observeUser(id: String): Flow<User?>
}

// :data  (Android library, depends on :domain)
class UserRepositoryImpl @Inject constructor(
    private val api: UserApi,
    private val dao: UserDao,
    @IoDispatcher private val io: CoroutineDispatcher,
) : UserRepository {
    override suspend fun getUser(id: String) = withContext(io) {
        safeCall { api.getUser(id).toDomain() }
    }
    override fun observeUser(id: String): Flow<User?> =
        dao.observeUser(id).map { it?.toDomain() }
}
```

```kotlin
// :data  (Hilt lives here or in :app, never in :domain)
@Module
@InstallIn(SingletonComponent::class)
abstract class UserDataModule {
    @Binds
    @Singleton
    abstract fun bindUserRepository(impl: UserRepositoryImpl): UserRepository
}
```

`UserRepositoryImpl : UserRepository` makes the source arrow point from data to domain, even though domain calls data at runtime.

> **Note:** `@Inject` comes from `javax.inject`, a tiny pure Java artifact, so it is fine in a pure Kotlin domain. `@Module`, `@InstallIn` and `@HiltViewModel` belong in Android modules.

### The typical Android mapping

Most teams collapse the circles into three layers.

| Layer | Contains | Depends on |
|---|---|---|
| Presentation | Composables, ViewModels, UI state, UI models | Domain |
| Domain | Domain models, use cases, repository interfaces | Nothing (pure Kotlin) |
| Data | Repository impls, data sources, DTOs, Room entities, mappers | Domain |

```text
  presentation  ------>  domain  <------  data
  (Android)            (pure Kotlin)     (Android)
```

Domain sits in the middle and knows no one. The `:app` module, which owns the DI graph, is the only place that sees everything.

### Google's guide vs Clean Architecture

The layer names look the same, but the arrows differ. This is a favorite senior question.

| Aspect | Google's guide | Clean Architecture |
|---|---|---|
| Dependency direction | UI to domain to data | Presentation and data both point to domain |
| Repository lives in | Data layer | Interface in domain, impl in data |
| Domain layer | Optional | Required, it is the center |
| Domain depends on | Data repositories and models | Nothing outside itself |
| Models | Often shared across layers | Separate per layer, with mappers |
| Use cases | Only for reuse or complexity | Often one per user action |

In Google's guide a use case imports `NewsRepository` from the data layer. In Clean Architecture the domain owns `NewsRepository` as an interface.

> **Tip:** Many real codebases are a hybrid: Google's layer names plus repository interfaces in a pure Kotlin domain module. Say you know both and choose by team size and app complexity.

### Why the domain should be pure Kotlin

- **Fast tests.** Plain JVM tests, no Robolectric, no emulator.
- **Enforced boundaries.** A `kotlin("jvm")` module cannot import `android.*` at all.
- **Reuse.** The same code works in Kotlin Multiplatform, a backend or a CLI.
- **Stability.** Android and library upgrades do not touch business rules.

Fine in domain: `kotlinx.coroutines` (`Flow`, `suspend`), `javax.inject`, `java.time` or `kotlinx-datetime`. Not fine: `Context`, `LiveData`, `Parcelable`, Room or Retrofit annotations, `@StringRes`.

### MVVM, MVI and Clean together

MVVM and MVI are **presentation patterns**: they shape one screen. Clean Architecture is **app-wide**: it shapes layers and dependency direction. They are not alternatives. The ViewModel sits in the Interface Adapters circle.

> **Interview:** If asked "MVVM or Clean Architecture?", correct the framing: "They work at different levels. MVVM or MVI shapes one screen; Clean shapes the whole app. I use them together."

### When not to use it

Full Clean Architecture costs more files, mappers, modules and indirection. It pays off for large, long-lived apps, complex changing rules, or code shared across platforms. It is over-engineering for a prototype or a small CRUD app. A pragmatic version:

1. Keep DTOs separate from the models the rest of the app uses.
2. Put repository interfaces next to the domain models, in a pure Kotlin module or package.
3. Add use cases only where there is real logic or reuse.
4. Let presentation use domain models directly when no formatting is needed.
5. Split into more modules only when build time or team size demands it.

:::check
Q: Your `:domain` module is an Android library, and someone adds `@StringRes` to a domain error. Code review misses it. What would have caught it?
A: Making `:domain` a pure `kotlin("jvm")` module. Android annotations and classes are not on its classpath, so the code fails to compile.
Q: In Google's guide and in Clean Architecture, which module declares `NewsRepository`, and which way does the arrow between domain and data point?
A: Google: the data layer declares it, so domain depends on data. Clean: domain declares the interface and data implements it, so data depends on domain.
Q: Interview: How would you introduce Clean Architecture into a small, fast-moving app without drowning in boilerplate?
A: Keep DTOs separate, put repository interfaces in a pure Kotlin domain, add use cases only for real logic or reuse, and let simple screens use domain models directly. Add modules only when build times or team boundaries hurt.
:::

## Use cases, models and mappers

How to write use cases that earn their place, give each layer its own model, and carry errors across layers safely.

:::tldr
- A use case is one action with one `operator fun invoke`; it holds real rules or combines repositories.
- DTO, domain model and UI model are separate; mappers live in the outer layer of each boundary.
- Data maps exceptions to a sealed `DomainError`; presentation maps that to a string resource.
:::

### A good use case

A use case represents **one action the user or system can take**. Its single entry point is `operator fun invoke`, so callers write `getUserProfile(id)`.

```kotlin
class GetUserProfileUseCase @Inject constructor(
    private val userRepository: UserRepository,
    private val sessionRepository: SessionRepository,
) {
    suspend operator fun invoke(userId: String): AppResult<UserProfile> {
        val myId = sessionRepository.currentUserId()
        return userRepository.getUser(userId).map { user ->
            UserProfile(
                user = user,
                isMe = user.id == myId,
                canMessage = user.id != myId && !user.isBlocked,
            )
        }
    }
}
```

Good use cases:

- **Do one thing**, named verb + noun: `PlaceOrderUseCase`.
- **Combine repositories**, so the ViewModel does not need to know a profile needs the session too.
- **Hold real rules**, like "you cannot message yourself or a blocked user".
- **Are main-safe and stateless.** No mutable fields, so they are cheap and safe to share.

Use cases can return `Flow` when the result changes over time:

```kotlin
class ObserveUnreadCountUseCase @Inject constructor(
    private val messages: MessageRepository,
    private val settings: SettingsRepository,
) {
    operator fun invoke(): Flow<Int> =
        combine(messages.observeUnread(), settings.observeMutedChats()) { unread, muted ->
            unread.count { it.chatId !in muted }
        }
}
```

### The pass-through smell

```kotlin
class GetUserUseCase @Inject constructor(private val repo: UserRepository) {
    suspend operator fun invoke(id: String) = repo.getUser(id)
}
```

This adds a file and a test but no behavior. Some teams keep pass-throughs so that "ViewModels only talk to use cases". That is a valid team rule, but know the cost.

### Models per layer

- **DTO** (data): mirrors the JSON. Nullable fields, API names, `@Serializable`.
- **Entity** (data): mirrors a Room table.
- **Domain model** (domain): business meaning. Non-null, typed, no annotations.
- **UI model** (presentation): what the screen shows. Formatted strings, flags.

```text
UserDto (JSON)   --toDomain()-->  User  --toUi()-->  ProfileUi
UserEntity (Room) --toDomain()--/
```

Mappers live in the **outer** layer of each boundary, because only it knows both types. `UserDto.toDomain()` lives in data; `User.toUi()` lives in presentation.

```kotlin
@Serializable
data class UserDto(
    @SerialName("id") val id: String,
    @SerialName("display_name") val displayName: String?,
    @SerialName("created_at") val createdAt: String,
    @SerialName("blocked") val blocked: Boolean? = null,
)

fun UserDto.toDomain() = User(
    id = id,
    name = displayName ?: "Unknown",
    joinedAt = Instant.parse(createdAt),
    isBlocked = blocked ?: false,
)
```

An API rename now changes one DTO and one mapper, not every screen. Nullability is handled once, at the edge. Pragmatic rule: always separate DTOs, but let simple screens use the domain model directly.

### Errors across layers

Each layer speaks its own error language. The domain owns a result type and a sealed error.

```kotlin
sealed interface AppResult<out T> {
    data class Success<T>(val data: T) : AppResult<T>
    data class Failure(val error: DomainError) : AppResult<Nothing>
}

sealed interface DomainError {
    data object NoNetwork : DomainError
    data object NotFound : DomainError
    data object Unauthorized : DomainError
    data class Unknown(val cause: Throwable) : DomainError
}
```

The data layer catches only the types it expects, so `CancellationException` still propagates.

```kotlin
suspend fun <T> safeCall(block: suspend () -> T): AppResult<T> = try {
    AppResult.Success(block())
} catch (e: IOException) {
    AppResult.Failure(DomainError.NoNetwork)
} catch (e: HttpException) {
    AppResult.Failure(
        when (e.code()) {
            401 -> DomainError.Unauthorized
            404 -> DomainError.NotFound
            else -> DomainError.Unknown(e)
        }
    )
}
```

Presentation maps the domain error to text with an exhaustive `when`:

```kotlin
@StringRes
fun DomainError.toMessageRes(): Int = when (this) {
    DomainError.NoNetwork -> R.string.error_no_network
    DomainError.NotFound -> R.string.error_user_not_found
    DomainError.Unauthorized -> R.string.error_signed_out
    is DomainError.Unknown -> R.string.error_generic
}
```

Add a new error case and the compiler points at every `when` that must handle it.

> **Pitfall:** Do not name your type `Result`; it clashes with `kotlin.Result`. Also avoid `runCatching` around suspend calls, because it swallows `CancellationException`.

:::deeper The map helper and the ViewModel side
`AppResult.map` keeps the success path short:

```kotlin
inline fun <T, R> AppResult<T>.map(transform: (T) -> R): AppResult<R> =
    when (this) {
        is AppResult.Success -> AppResult.Success(transform(data))
        is AppResult.Failure -> this
    }
```

The ViewModel then does one `when`: `Success` becomes `ProfileUiState.Content(result.data.toUi())`, and `Failure` becomes `ProfileUiState.Error(result.error.toMessageRes())`. The ViewModel never sees `IOException` or `HttpException`.
:::

:::check
Q: Where should `fun User.toUserDto()` live, and why is putting it in the domain module wrong?
A: In the data module. The domain would then know a data-layer type, which breaks the Dependency Rule.
Q: `safeCall` uses `catch (e: Exception)` instead of specific types. What bug can that cause?
A: It also catches `CancellationException`, so a cancelled coroutine turns into a `Failure` and keeps running instead of stopping. Catch the expected types or rethrow cancellation.
Q: Interview: When is a use case worth adding, and when is it noise?
A: Worth it when it holds a business rule, combines repositories, or is reused by several ViewModels. A use case that only forwards one repository call is noise, unless the team has explicitly agreed on that convention.
:::

## Jetpack ViewModel deep dive

How a ViewModel is created, stored, kept across rotation, cleared, and given its dependencies.

:::tldr
- A ViewModel lives in a `ViewModelStore` owned by an Activity, Fragment or navigation entry, and survives config changes.
- `viewModelScope` is cancelled in `onCleared()`; `SavedStateHandle` survives process death.
- Create ViewModels through a provider: `hiltViewModel()`, `viewModel(factory)` or `by viewModels()`, never a constructor call.
:::

### What a ViewModel is

A `ViewModel` is a screen-level state holder that outlives configuration changes. It is scoped to a `ViewModelStoreOwner`: an Activity, a Fragment or a navigation back stack entry. It lives until that owner is gone for good.

```text
Activity created  ->  ViewModel created
Rotation          ->  Activity recreated, SAME ViewModel
Back pressed      ->  Activity finished -> ViewModel.onCleared()
```

### How it survives rotation

Each owner has a `ViewModelStore`, basically a map from key to ViewModel. `ViewModelProvider` looks up the key. If found, it returns the same instance; if not, it asks a factory to create one.

> **Under the hood:** `ComponentActivity` hands its `ViewModelStore` to the new instance through `onRetainNonConfigurationInstance()`. On destroy it checks `isChangingConfigurations`; only when it is false does it call `clear()` on the store, which calls `onCleared()` on every ViewModel.

In Compose, `viewModel()` and `hiltViewModel()` do this lookup with the nearest `LocalViewModelStoreOwner`.

### onCleared and viewModelScope

`onCleared()` runs once, when the owner is gone for good. `viewModelScope` is cancelled at that moment.

```kotlin
class ProfileViewModel(private val repo: UserRepository) : ViewModel() {
    init {
        viewModelScope.launch {
            repo.refreshProfile() // cancelled when the VM is cleared
        }
    }

    override fun onCleared() {
        // release non-coroutine resources here
        super.onCleared()
    }
}
```

> **Under the hood:** `viewModelScope` uses `SupervisorJob() + Dispatchers.Main.immediate`, so one failed child does not cancel its siblings. You can also register `AutoCloseable` resources with `addCloseable()`; they close when the ViewModel is cleared.

### SavedStateHandle and process death

`SavedStateHandle` is a key-value map written into the saved instance state `Bundle`. It survives process death. Hilt and the default factories can inject it.

```kotlin
@HiltViewModel
class SearchViewModel @Inject constructor(
    private val savedStateHandle: SavedStateHandle,
) : ViewModel() {
    val query: StateFlow<String> =
        savedStateHandle.getStateFlow(KEY_QUERY, "") // restored after death

    fun onQueryChange(newQuery: String) {
        savedStateHandle[KEY_QUERY] = newQuery
    }

    private companion object { const val KEY_QUERY = "query" }
}
```

- Store only small, Bundle-friendly data: ids, queries, the selected tab. Never lists of results.
- Reload big data from the repository using the saved id.
- Navigation arguments also arrive here. With type-safe Navigation Compose, read them with `savedStateHandle.toRoute<MyRoute>()`.

> **Tip:** To test process death, background the app, run `adb shell am kill your.package.name`, then reopen it from Recents. "Don't keep activities" only tests Activity recreation, not a real process kill.

### Factories and CreationExtras

A ViewModel with constructor parameters needs a factory. The modern way uses `CreationExtras` and the `viewModelFactory` DSL.

```kotlin
class DetailViewModel(
    private val repo: DetailRepository,
    private val savedStateHandle: SavedStateHandle,
) : ViewModel() {
    companion object {
        val Factory: ViewModelProvider.Factory = viewModelFactory {
            initializer {
                val app = this[APPLICATION_KEY] as MyApplication
                DetailViewModel(app.container.detailRepository, createSavedStateHandle())
            }
        }
    }
}
// Compose: val vm: DetailViewModel = viewModel(factory = DetailViewModel.Factory)
```

`CreationExtras` is a bag of values the system passes to the factory, such as the `Application` and what is needed to build a `SavedStateHandle`.

### Hilt

With Hilt you skip factories.

```kotlin
@HiltViewModel
class CartViewModel @Inject constructor(
    private val cartRepository: CartRepository,
    private val savedStateHandle: SavedStateHandle,
) : ViewModel()

@Composable
fun CartRoute(viewModel: CartViewModel = hiltViewModel()) { /* ... */ }
```

- In Views, use `by viewModels()` inside an `@AndroidEntryPoint` Activity or Fragment.
- In a navigation graph, `hiltViewModel()` scopes to the current back stack entry.
- For runtime values not in `SavedStateHandle`, use assisted injection with `@HiltViewModel(assistedFactory = ...)`.

> **Pitfall:** Never write `MyViewModel()` in UI code. It is not stored in a `ViewModelStore`, so it is recreated on every rotation and `onCleared()` never runs.

:::deeper 2025-era notes
- ViewModel, `viewModelScope` and `SavedStateHandle` are now Kotlin Multiplatform in recent lifecycle releases.
- In Hilt 1.3, `hiltViewModel()` moved to the `hilt-lifecycle-viewmodel-compose` artifact; the old `hilt-navigation-compose` one still works.
- Navigation 3 keeps the back stack as your own list. To scope a ViewModel to an entry, add the ViewModel store entry decorator from `lifecycle-viewmodel-navigation3`.
:::

:::check
Q: Two composables in the same navigation destination both call `hiltViewModel<CartViewModel>()`. How many instances exist?
A: One. Both look up the same key in the same back stack entry's `ViewModelStore`.
Q: A ViewModel keeps a 2 MB list of results in `SavedStateHandle`. What can go wrong?
A: The saved state Bundle has a size limit, and a large one can throw `TransactionTooLargeException`. Save only the query or id and reload the list from the repository.
Q: Interview: Walk through what happens to a ViewModel on rotation versus on back press.
A: On rotation, `ComponentActivity` passes the `ViewModelStore` to the new Activity because `isChangingConfigurations` is true, so the same instance is returned. On back press the Activity finishes, the store is cleared, `onCleared()` runs and `viewModelScope` is cancelled.
:::

## Exposing UI state

How a ViewModel should model and expose screen state with `StateFlow`, and how the UI should collect it.

:::tldr
- Model each screen as one immutable `UiState`; keep a private `MutableStateFlow` and expose a read-only `StateFlow`.
- Change owned state with `update { }`; derive state from repositories with `combine` plus `stateIn`.
- Collect with `collectAsStateWithLifecycle()` in Compose or `repeatOnLifecycle(STARTED)` in Views.
:::

### One immutable UiState

Google recommends modelling the screen as one immutable state object. The UI renders it and never mutates it.

```kotlin
data class NewsUiState(
    val isLoading: Boolean = false,
    val articles: List<ArticleUi> = emptyList(),
    val userMessage: String? = null,
    val isSignedIn: Boolean = false,
)
```

The screen is always consistent, easy to log, and tests compare one object.

When states are mutually exclusive, a sealed interface is safer:

```kotlin
sealed interface ProfileUiState {
    data object Loading : ProfileUiState
    data class Success(val name: String, val avatarUrl: String) : ProfileUiState
    data class Error(val message: String) : ProfileUiState
}
```

Use a sealed type when only one case can exist. Use a data class with flags when parts are independent, like a refresh spinner over existing content. Many screens mix both: a data class with a sealed `content` field.

### One stream or many

| Approach | Good | Bad |
|---|---|---|
| One `StateFlow<UiState>` | Always consistent, simple to test | Any change re-emits the whole object |
| Several `StateFlow`s | Parts update independently | Streams can disagree; UI must combine |

Start with one stream. In Compose, re-emitting one object is cheap, because composables whose inputs did not change are skipped.

### MutableStateFlow and update

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

> **Tip:** Use `update { }`, not `_uiState.value = _uiState.value.copy(...)`. `update` is a compare-and-set loop, so two concurrent updates cannot overwrite each other.

### Derive state with combine and stateIn

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

`stateIn` turns a cold `Flow` into a hot `StateFlow`. The `SharingStarted` options:

- `Eagerly`: starts at once, never stops.
- `Lazily`: starts on the first subscriber, never stops.
- `WhileSubscribed(5_000)`: starts on the first subscriber, stops 5 seconds after the last one leaves.

> **Interview:** Why 5,000 ms? A rotation takes well under 5 seconds, so the upstream stays alive and nothing is re-fetched. In the background for longer, the upstream stops and saves battery and work.

### Collecting in the UI

```kotlin
@Composable
fun NewsRoute(viewModel: NewsViewModel = hiltViewModel()) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    NewsScreen(uiState = uiState, onBookmark = viewModel::onBookmark)
}
```

`collectAsStateWithLifecycle()` stops collecting when the lifecycle drops below `STARTED`. Plain `collectAsState()` keeps collecting in the background, which also keeps `WhileSubscribed` upstreams alive.

> **Tip:** Split each screen into a Route (gets the ViewModel, collects state) and a stateless Screen (takes `uiState` and lambdas). The Screen is easy to preview and test.

In the View system, collect with `repeatOnLifecycle`:

```kotlin
viewLifecycleOwner.lifecycleScope.launch {
    viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
        viewModel.uiState.collect { render(it) }
    }
}
```

:::deeper StateFlow behaviour worth knowing
- `StateFlow` always has a value and replays the latest one to new collectors.
- It skips values equal to the current one (`equals`), so `update { it }` emits nothing.
- It is conflated: a slow collector sees only the newest value, not every intermediate one.
- `LiveData` is still supported, but Kotlin-first code uses `StateFlow` with lifecycle-aware collection.
:::

:::check
Q: A ViewModel collects a repository flow in `init` and copies values into a `MutableStateFlow`. What is wasteful compared with `stateIn(WhileSubscribed(5_000))`?
A: The `init` collector runs for the ViewModel's whole life, even when the app is in the background. `WhileSubscribed` stops the upstream 5 seconds after the UI stops collecting.
Q: The screen uses `collectAsState()` and `WhileSubscribed(5_000)`. The user leaves the app for an hour. Does the upstream stop?
A: No. `collectAsState()` keeps collecting while the composition exists, so the subscriber never leaves. Use `collectAsStateWithLifecycle()`.
Q: Interview: Two coroutines call `_state.value = _state.value.copy(...)` at the same time. What can go wrong, and how do you fix it?
A: Both read the same old value, so one write overwrites the other and an update is lost. `update { }` retries with a compare-and-set loop until its change applies on the latest value.
:::

## UI events and one-off effects

How to handle navigation, snackbars and other one-time outputs without losing or repeating them.

:::tldr
- User events go up as function calls or intents; ViewModel events going down are the tricky part.
- Google's guidance: turn ViewModel events into state, and let the UI report back when it has handled them.
- If you use an effect stream, use a buffered `Channel` collected on `Main.immediate`; never replay one-off events.
:::

### Two kinds of events

- **User events** go up from the UI: a click, text input, pull to refresh. These are function calls (MVVM) or intents (MVI).
- **ViewModel events** go down to the UI: "show a snackbar", "navigate to detail". These are the hard ones.

Some user events never need the ViewModel. Expanding a card or scrolling a list is pure UI logic and can live in composable state.

### Events as state

Google's current guidance: a ViewModel event should become a UI state update. Instead of firing "show message", put the message in the state. The UI shows it, then tells the ViewModel.

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

Why: state cannot be lost. It survives rotation, and if the UI was hidden when it happened, it is still there when the UI returns. Navigation works the same way: an `isSaved` flag that the UI reacts to by navigating and then reporting back.

> **Note:** If the UI can act directly on a click, such as navigating when a button is tapped, skip the ViewModel round trip. Call the navigation lambda from the UI.

### Channel vs SharedFlow

Many teams, and almost every MVI library, still use a separate effect stream. Know the trade-offs.

| Option | No collector | Many collectors | Main risk |
|---|---|---|---|
| `Channel(BUFFERED)` + `receiveAsFlow()` | Buffers until collected | Each event to one collector | Rare loss between delivery and handling |
| `MutableSharedFlow(replay = 0)` | Event dropped | All collectors get it | Events lost while UI is stopped |
| `MutableSharedFlow(replay = 1)` | Last event kept | All collectors get it | Replays after rotation (double navigation) |
| State + "shown" callback | Kept in state | Any observer | A little more code, no loss |

A `Channel` is the usual choice. To avoid losing events during a configuration change, collect on `Dispatchers.Main.immediate` inside a lifecycle-aware block.

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

Sending is a suspend call, so the ViewModel does it in a coroutine:

```kotlin
private val _effects = Channel<Effect>(Channel.BUFFERED)
val effects: Flow<Effect> = _effects.receiveAsFlow()

fun onSaved() {
    viewModelScope.launch { _effects.send(Effect.NavigateBack) }
}
```

> **Pitfall:** Do not use `SharedFlow(replay = 0)` for navigation. If it is emitted while the app is in the background, nobody is subscribed and the event is gone forever.

### Choosing in practice

- Snackbars and messages: state with a "shown" callback works well and survives everything.
- Navigation after async work (save, then go back): state flag or a `Channel` effect; both are defensible.
- Navigation straight from a click: call the lambda from the UI.

> **Interview:** "Google recommends events as state with a consumed callback, because state cannot be lost. If I use an effect stream, it is a buffered Channel collected with repeatOnLifecycle on Main.immediate, and I never replay one-off events."

:::check
Q: A save finishes while the user has the app in the background, and the ViewModel emits `Navigate` into a `MutableSharedFlow()` with no replay. What happens when the user returns?
A: Nothing. There was no subscriber when it was emitted, so the event was dropped and the user stays on the form.
Q: A team uses `MutableSharedFlow(replay = 1)` for navigation. What bug do they see after rotation?
A: The new collector receives the replayed old event and navigates again. One-off events must not be replayed.
Q: Interview: Why does Google prefer modelling one-off events as state?
A: State is never lost and never duplicated: it survives rotation, waits while the UI is hidden, and is cleared only when the UI says it handled it. Effect streams need careful buffering and collection to get close to that.
:::

## MVI in depth

The parts of MVI, the one-way loop, and why the reducer must be a pure function.

:::tldr
- MVI has intents (actions), one immutable state, a pure reducer, side effects, and one-off effects.
- The UI only sends actions; only the reducer makes new state; side effects report back as actions.
- A pure reducer is trivial to test and makes every state change reproducible and loggable.
:::

### The parts

- **Intent (or Action):** a typed description of something that happened, usually a sealed interface. Examples: `QueryChanged("kot")`, `RetryClicked`.
- **Model (State):** one immutable data class that fully describes the screen.
- **Reducer:** a pure function `(State, Action) -> State`. No I/O, no coroutines, no randomness, no clock.
- **Side effects:** impure work like network calls, database writes and timers. Their results come back as new actions.
- **Effects (also called Events or Labels):** one-off outputs to the UI, such as navigation or a toast.

### The loop

```text
   +--------+  Action   +-------------+
   |   UI   | --------> |   Store /   |
   |Compose |           |  ViewModel  |
   +--------+           +-------------+
       ^                   |        |
       |                   v        v
       |  State     +---------+  +--------------+
       +----------- | Reducer |  | Side effects | --> Effect
                    | (pure)  |  | (repo, I/O)  |    (nav, toast)
                    +---------+  +--------------+
                         ^              |
                         +--- result as a new Action
```

The UI never changes state. It sends actions. The reducer is the only place that produces new state. Side effects run outside it and dispatch more actions with their results.

### A pure reducer

```kotlin
data class CounterState(val count: Int = 0)

sealed interface CounterAction {
    data object Increment : CounterAction
    data object Decrement : CounterAction
    data object Reset : CounterAction
}

fun reduce(state: CounterState, action: CounterAction): CounterState =
    when (action) {
        CounterAction.Increment -> state.copy(count = state.count + 1)
        CounterAction.Decrement -> state.copy(count = state.count - 1)
        CounterAction.Reset -> CounterState()
    }
```

Why purity matters:

- You test it with plain function calls. No coroutines, no fakes.
- Same input, same output, so bugs are reproducible.
- You can log every `(action, oldState, newState)`. Replaying logged actions rebuilds the exact state. This is the idea behind "time-travel debugging".

> **Pitfall:** Calling a repository, reading `System.currentTimeMillis()` or launching a coroutine inside the reducer breaks purity. Move that work to side-effect handlers and pass results in as actions.

### Public vs internal actions

Separate actions the UI may send from internal results.

- UI actions: `QueryChanged`, `Retry`, `ResultClicked`.
- Internal results (also called mutations or partial states): `SearchStarted`, `SearchSucceeded`, `SearchFailed`.

Both go through the same reducer. Only the UI ones are public API. Some teams use two sealed types to make this explicit.

### A minimal store

The ViewModel acts as the store. One entry point applies the reducer, then runs side effects.

```kotlin
abstract class MviViewModel<S, A>(initial: S) : ViewModel() {
    private val _state = MutableStateFlow(initial)
    val state: StateFlow<S> = _state.asStateFlow()

    protected abstract fun reduce(state: S, action: A): S
    protected open fun onSideEffect(action: A) {}

    fun dispatch(action: A) {
        _state.update { reduce(it, action) }
        onSideEffect(action)
    }
}
```

`update` keeps each reduction atomic. Some libraries also queue actions through a `Channel` so they are processed strictly in order.

> **Under the hood:** `update` may call your lambda more than once if another update wins the race. That is safe only because the reducer is pure. A reducer with side effects could run them twice.

:::deeper MVI libraries worth knowing by name
- **Orbit MVI:** a lightweight `container` with `intent { }`, `reduce { }` and `postSideEffect()`.
- **Mavericks:** Airbnb's framework with `MavericksViewModel`, immutable state and `setState { copy(...) }`.
- **Circuit:** Slack's Compose-first architecture; a `Presenter` composable produces state for a `Ui`.
- **Molecule:** Cash App's library that turns a `@Composable` function into a `StateFlow`, so presenter logic uses Compose runtime instead of Flow operators.
:::

:::check
Q: A reducer does `state.copy(updatedAt = System.currentTimeMillis())`. Why is that a problem, and how do you fix it?
A: The reducer is no longer pure: the same action gives different state and tests are flaky. Read the time in a side effect or inject a clock there, and pass the value in the action.
Q: Why is it dangerous to launch a network call inside the lambda passed to `_state.update { }`?
A: `update` can retry the lambda on contention, so the call could run twice. Side effects belong outside the reducer.
Q: Interview: Where do side effects go in MVI, and how do their results reach the state?
A: In a side-effect handler inside the ViewModel, outside the reducer. It reacts to actions, does I/O in `viewModelScope`, and dispatches result actions like `SearchSucceeded` back through the reducer.
:::

## Worked example: search in MVVM

A full search screen in Google-style MVVM: debounce, latest-wins, process death and all five states.

:::tldr
- The query lives in `SavedStateHandle`, so it survives process death and updates the text field instantly.
- Results are derived with `debounce` plus `flatMapLatest`, so a slow old response can never overwrite a newer one.
- The Route collects state; a stateless Screen renders idle, loading, empty, success and error.
:::

### The feature

The user types. After a 300 ms pause, the app searches. It shows loading, results, an empty message, or an error with Retry. Tapping a result opens a detail screen. The query must survive process death.

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

The `query` is separate from `results`, so the text field updates at once while results are debounced. The sealed type makes "spinner plus error" impossible.

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
    // continued below
```

```kotlin
    fun onQueryChange(newQuery: String) { savedStateHandle[KEY_QUERY] = newQuery }
    fun onRetry() { retryTrigger.update { it + 1 } }

    private companion object { const val KEY_QUERY = "query" }
}
```

`flatMapLatest` cancels the previous search when a new query arrives. Retry bumps a counter, which makes `combine` emit the same query again and restart the search.

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
    } catch (e: IOException) {
        emit(SearchResults.Error("Check your connection and try again"))
    }
}
```

Only `IOException` is caught, so `CancellationException` from `flatMapLatest` passes through untouched.

> **Pitfall:** `runCatching { }` around a suspend call also catches `CancellationException`, which breaks structured concurrency. Catch only the types you expect, or rethrow cancellation.

### Compose: Route

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

The click needs no logic, so the UI calls `onOpenItem` directly. No ViewModel round trip.

### Compose: stateless Screen

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
        SearchResultsContent(uiState.results, onRetry, onItemClick)
    }
}
```

```kotlin
@Composable
fun SearchResultsContent(r: SearchResults, onRetry: () -> Unit, onItemClick: (String) -> Unit) {
    when (r) {
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
```

> **Note:** Keeping text in a `StateFlow` works if the write is synchronous, as here. If the value goes through an async pipeline before reaching the field, the cursor can jump. Newer Compose also offers `TextFieldState` for text input.

:::check
Q: Replace `flatMapLatest` with `flatMapConcat`. The user types "ko" then "kotlin", and the "ko" request is slow. What does the screen show?
A: The "ko" search runs to completion before "kotlin" starts, so the user sees stale "ko" results first and waits longer. `flatMapLatest` cancels the "ko" search as soon as "kotlin" arrives.
Q: The OS kills the app while the query is "compose". What happens when the user returns?
A: `getStateFlow` restores "compose" from the saved state, the debounce fires, and the search reruns, so the user sees results again without retyping.
Q: Interview: How do you stop an old search response from overwriting a newer one?
A: Make starting a new search cancel the old one: `flatMapLatest`, `collectLatest`, or cancelling the previous `Job`. A cancelled request can never emit its results.
:::

## Worked example: search in MVI

The same search screen rebuilt in MVI: a contract, a pure reducer, side effects and an effect stream.

:::tldr
- The contract is three types: `SearchState`, a sealed `SearchAction`, and a sealed `SearchEffect`.
- `dispatch` is the only entry point: reduce first, then run side effects that send result actions back.
- Cancelling the previous job on each keystroke gives both debounce and latest-wins.
:::

### State

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
```

### Actions and effects

```kotlin
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

> **Pitfall:** Here `isEmpty` is briefly true right after typing, before the debounce fires and loading starts. The MVVM version avoids this with explicit `Idle` and `Loading` cases. A fix is to set a pending flag on `QueryChanged`. Small details like this make good interview talking points.

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

It is a top-level pure function. It knows nothing about coroutines or repositories.

### ViewModel as the store

```kotlin
@HiltViewModel
class SearchMviViewModel @Inject constructor(
    private val repository: SearchRepository,
    private val savedStateHandle: SavedStateHandle,
) : ViewModel() {
    private val _state = MutableStateFlow(SearchState(query = savedStateHandle[KEY_QUERY] ?: ""))
    val state: StateFlow<SearchState> = _state.asStateFlow()

    private val _effects = Channel<SearchEffect>(Channel.BUFFERED)
    val effects: Flow<SearchEffect> = _effects.receiveAsFlow()

    private var searchJob: Job? = null

    init { if (_state.value.query.isNotBlank()) search(_state.value.query, debounceMs = 0) }

    fun dispatch(action: SearchAction) {
        _state.update { reduce(it, action) }
        handleSideEffects(action)
    }
    // side effects below
```

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
```

```kotlin
    private fun search(query: String, debounceMs: Long) {
        searchJob?.cancel()
        if (query.isBlank()) return
        searchJob = viewModelScope.launch {
            delay(debounceMs) // cancel-and-restart = debounce
            dispatch(SearchAction.SearchStarted)
            try {
                dispatch(SearchAction.SearchSucceeded(repository.search(query.trim())))
            } catch (e: IOException) {
                dispatch(SearchAction.SearchFailed("Check your connection and try again"))
            }
        }
    }

    private companion object { const val KEY_QUERY = "query" }
}
```

Cancelling the previous job on every query gives debounce and latest-wins together. A `CancellationException` is not an `IOException`, so it is not swallowed.

### Compose

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

The Screen takes one `onAction: (SearchAction) -> Unit` instead of a lambda per event. Inside it you write `onAction(SearchAction.QueryChanged(it))`.

> **Tip:** Routing this click through an effect only shows the pattern. If the click needs no logic (no analytics, no validation), calling `onOpenItem` from the UI is simpler and matches Google's guidance.

### What changed

- MVVM: several public functions; state derived with `combine` and `flatMapLatest`.
- MVI: one `dispatch`, a pure reducer, explicit internal actions, a separate effect stream.
- Both: one immutable state, `StateFlow`, one-way flow, `SavedStateHandle` for the query, latest-wins search.

:::check
Q: The user types "k", "ko", "kot" within 200 ms. How many repository calls happen?
A: One, for "kot". Each `QueryChanged` cancels the previous job during its 300 ms `delay`, so only the last job reaches `repository.search`.
Q: The Screen calls `onAction(SearchAction.SearchSucceeded(emptyList()))`. Is anything stopping it, and should something?
A: Nothing stops it, because internal results share the public sealed type. Splitting UI actions and internal results into two types keeps the UI from faking results.
Q: Interview: Why reduce first and run side effects after, inside `dispatch`?
A: The state then reflects the action before any I/O starts, and side effects can read the new state, as Retry reads the current query. The reducer stays pure while all impure work happens in one predictable place afterward.
:::

## MVVM vs MVI

How the two patterns really differ, where each one wins, and how to answer the "which one?" question.

:::tldr
- Modern MVVM already uses one `UiState` and one-way flow; MVI adds typed actions and a pure reducer.
- MVI wins on complex, event-heavy screens; MVVM wins on simplicity and matches the official docs.
- Both need care with concurrency: `flatMapLatest` in MVVM, ordered atomic reductions in MVI.
:::

### Side by side

| Aspect | MVVM (Google style) | MVI |
|---|---|---|
| UI to ViewModel | Plain functions like `onRetry()` | One `dispatch(action)` with a sealed type |
| State | Usually one `UiState` | Always one immutable state |
| State changes | Anywhere in the ViewModel via `update` | Only in the reducer |
| Boilerplate | Low | Higher (actions, effects, reducer) |
| Debuggability | Good with discipline | Very good, every change has a named action |
| Time-travel debugging | Not natural | Possible by replaying logged actions |
| Testability | Through public functions and state | Reducer tests are trivial, plus VM tests |
| Learning curve | Lower, matches official docs | Steeper, more concepts |
| Best for | Most screens, CRUD, small teams | Complex screens with many interacting events |

### The real difference

People argue about MVVM vs MVI as if they were opposites. In 2025-era Android they are close cousins.

Google-style MVVM already has a single immutable `UiState`, `StateFlow`, unidirectional data flow and events as state. What MVI adds on top:

1. **Typed input.** Every user action is a value of a sealed type, not a function call.
2. **One entry point.** `dispatch(action)` is the only door into the ViewModel.
3. **Pure reducer.** All state changes happen in one pure function.
4. **Explicit effects.** One-off outputs have their own sealed type.

### When MVI pays off

- A multi-step checkout or editor where many events interact with each other.
- Screens where bugs are hard to reproduce, so a log of `(action, state)` pairs is valuable.
- Teams that want one strict convention for every screen.
- Analytics or undo, where every action already being a value is handy.

### When MVVM is enough

- Lists, details, settings, simple forms: most screens.
- Small teams or new developers who learn from the official docs.
- State mostly derived from repository flows with `combine`, where a reducer adds little.

### Concurrency notes

- **MVI:** actions from several coroutines could race. `update` keeps each reduction atomic. Some libraries queue actions through a `Channel` so they run strictly in order.
- **MVVM:** `combine`, `flatMapLatest` and `stateIn` handle most concurrency. The common bug is forgetting `flatMapLatest` (using `map` plus launched jobs), so old responses overwrite new ones.

### Hybrid shapes you will meet

Many codebases mix the styles. A common one: an MVVM ViewModel that exposes one `onAction(action)` function taking a sealed `UiAction`, with `update { }` calls inside, but no separate reducer.

That keeps typed input and a single entry point, which helps with logging and with a single lambda in Compose. It skips the pure reducer, so it is cheaper but less strict.

> **Interview:** There is no single right answer, so say what you would pick and why: "Google-style MVVM with a single UiState and UDF by default. On complex screens, like a multi-step checkout, I move to MVI, where a pure reducer and a log of actions pay for themselves."

### How it fits with Clean Architecture

Both patterns live only in the presentation layer. The ViewModel calls use cases or repository interfaces and maps domain models into UI state. Switching a screen from MVVM to MVI does not touch domain or data at all.

:::deeper A logging middleware for free
Because every change goes through `dispatch`, MVI makes tracing almost free:

```kotlin
fun dispatch(action: SearchAction) {
    val before = _state.value
    _state.update { reduce(it, action) }
    if (BuildConfig.DEBUG) Log.d("Search", "$action: $before -> ${_state.value}")
    handleSideEffects(action)
}
```

In MVVM you would need a log line in every public function to get the same trace.
:::

:::check
Q: A screen has 3 events and loads one list from Room. A teammate wants full MVI with reducer, effects and internal actions. What is your view?
A: Probably overkill. With few events and state derived from one flow, MVVM with a single `UiState` is simpler, and the reducer would add files without catching real bugs.
Q: A bug report says "sometimes the cart total is wrong after quickly adding and removing items". Which pattern helps you debug it, and how?
A: MVI. Every change is a logged action, so you can replay the exact action sequence through the pure reducer in a unit test and reproduce the bug.
Q: Interview: MVVM or MVI for a new app?
A: Explain the trade-off instead of naming a winner. MVVM with a single `UiState` and UDF is the default with less ceremony; MVI adds typed actions, a pure reducer and traceability, which pay off on complex, event-heavy screens or in teams that want one strict convention.
:::

## Loading, error, empty and paging

How to model every state a data screen can be in, and how Paging 3 fits next to your UiState.

:::tldr
- Every data screen has at least idle, loading, content, empty and error; model each one on purpose.
- Keep showing content during refresh; use a full-screen error only when there is nothing to show.
- Paging 3: `Pager(...).flow.cachedIn(viewModelScope)`, exposed as its own flow, never inside `UiState`.
:::

### Model every state

Every data screen has at least five states: idle, loading, content, empty and error. Many have more: refreshing over content, partial error (content plus snackbar), and offline.

```kotlin
data class FeedUiState(
    val items: List<FeedItemUi> = emptyList(),
    val isInitialLoading: Boolean = true,
    val isRefreshing: Boolean = false,
    val errorMessage: UiText? = null,
) {
    val showEmpty: Boolean get() =
        !isInitialLoading && errorMessage == null && items.isEmpty()
    val showFullScreenError: Boolean get() =
        errorMessage != null && items.isEmpty()
}
```

Derived properties keep the rules in one place, so the composable just reads `showEmpty`.

### Rules of thumb

- If you already have content, keep showing it during refresh. Show the error as a snackbar.
- Use a full-screen error only when there is nothing to show.
- Never show a spinner and an error together. A sealed type or derived properties prevent it.
- Map exceptions to user-friendly messages in the ViewModel, not in the composable.

### Localized messages without Context

The ViewModel should not hold a `Context`, so it cannot call `getString`. Expose a resource id or a small `UiText` type and resolve it in the UI.

```kotlin
sealed interface UiText {
    data class Raw(val value: String) : UiText
    data class Res(@StringRes val id: Int, val args: List<Any> = emptyList()) : UiText
}

@Composable
fun UiText.asString(): String = when (this) {
    is UiText.Raw -> value
    is UiText.Res -> stringResource(id, *args.toTypedArray())
}
```

### A generic loading wrapper

Some codebases wrap flows in a small result type so loading and error work the same everywhere. Now in Android uses this idea (its type is called `Result`; here it is renamed to avoid clashing with `kotlin.Result`).

```kotlin
sealed interface LoadResult<out T> {
    data class Success<T>(val data: T) : LoadResult<T>
    data class Error(val exception: Throwable) : LoadResult<Nothing>
    data object Loading : LoadResult<Nothing>
}

fun <T> Flow<T>.asLoadResult(): Flow<LoadResult<T>> =
    map<T, LoadResult<T>> { LoadResult.Success(it) }
        .onStart { emit(LoadResult.Loading) }
        .catch { emit(LoadResult.Error(it)) }
```

`catch` only sees upstream exceptions, and it does not catch cancellation of the collector, so this is safe.

### Pagination

For a simple "load more", keep a page number and an `isLoadingMore` flag in state, and append results with `update`. For real infinite lists, use **Paging 3**.

- `PagingSource` loads pages from one source. `RemoteMediator` adds network plus database for offline-first paging.
- `Pager(...).flow` gives `Flow<PagingData<T>>`.
- In the ViewModel, `.cachedIn(viewModelScope)` keeps loaded pages across config changes.
- In Compose, `collectAsLazyPagingItems()` gives `LazyPagingItems`; read `loadState` for loading and errors at the top and bottom.

```kotlin
val feed: Flow<PagingData<FeedItem>> = Pager(
    config = PagingConfig(pageSize = 20),
    pagingSourceFactory = { repository.feedPagingSource() },
).flow.cachedIn(viewModelScope)
```

```kotlin
val items = viewModel.feed.collectAsLazyPagingItems()
when {
    items.loadState.refresh is LoadState.Loading -> FullScreenLoader()
    items.loadState.refresh is LoadState.Error -> FullScreenError(onRetry = items::retry)
    items.itemCount == 0 -> EmptyFeed()
    else -> FeedList(items) // footer reads loadState.append
}
```

> **Pitfall:** Do not put `PagingData` inside your `UiState`. It is a stream with its own lifecycle. Expose it as a separate `Flow` next to `StateFlow<UiState>`.

:::check
Q: The user has 50 items on screen and pull-to-refresh fails. With the `FeedUiState` above, what shows?
A: The 50 items stay, and the error appears as a snackbar, because `showFullScreenError` is true only when `items` is empty.
Q: A ViewModel exposes `Pager(...).flow` without `cachedIn`. What happens on rotation?
A: The new collector starts a fresh paging flow, so the list reloads from page one and scroll position is lost. `cachedIn(viewModelScope)` shares the loaded pages.
Q: Interview: How do you show localized error messages from a ViewModel that has no Context?
A: Expose a string resource id or a `UiText` sealed type in the state and resolve it in the composable with `stringResource`. The ViewModel stays free of Context and easy to unit test.
:::

## DI and modularization

How Hilt wires the layers together, which scopes to use, and how to split an app into modules that enforce the architecture.

:::tldr
- `@Binds` maps an interface to an implementation; `@Provides` builds things you do not own, like Retrofit or dispatchers.
- Scope only what must share state: `@Singleton` for caches, `@ViewModelScoped` for per-ViewModel helpers.
- Feature modules depend on core modules, never on each other; a pure Kotlin domain module enforces Clean boundaries.
:::

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

- `@Binds` maps an interface to an `@Inject`-constructed class. It generates less code than `@Provides`.
- `@Provides` is for things you cannot annotate, like Retrofit, Room or a dispatcher.
- Inject dispatchers instead of hard-coding `Dispatchers.IO`, so tests can pass a test dispatcher.

The `@IoDispatcher` qualifier is a small annotation you define once:

```kotlin
@Qualifier
@Retention(AnnotationRetention.BINARY)
annotation class IoDispatcher
```

### Scopes that matter

| Component | Scope annotation | Lives as long as |
|---|---|---|
| `SingletonComponent` | `@Singleton` | The Application |
| `ActivityRetainedComponent` | `@ActivityRetainedScoped` | Activity, across config changes |
| `ViewModelComponent` | `@ViewModelScoped` | One ViewModel instance |
| `ActivityComponent` | `@ActivityScoped` | One Activity instance |

Repositories with caches or shared state are usually `@Singleton`. A helper shared only by a ViewModel and its use cases can be `@ViewModelScoped`. Unscoped bindings create a new instance per injection, which is fine for stateless classes like use cases.

> **Pitfall:** Scoping everything `@Singleton` "to be safe" keeps objects in memory forever and hides bad dependencies. Scope only what must share state.

### Modularization

Large apps split code into Gradle modules. Google's [Now in Android](https://github.com/android/nowinandroid) is the usual reference.

```text
app/                 -> wires features, navigation host, DI graph
feature/search/      -> SearchViewModel, SearchScreen
feature/detail/
core/model/          -> plain Kotlin data classes
core/domain/         -> use cases (optional)
core/data/           -> repositories
core/database/       -> Room
core/network/        -> Retrofit
core/designsystem/   -> theme, shared components
core/testing/        -> fakes, MainDispatcherRule
```

- **Feature modules** depend on core modules, never on each other.
- **api/impl split:** `:feature:search:api` exposes a navigation route and public interfaces; `:feature:search:impl` holds the code. Others depend only on the api module, which cuts rebuilds and hides internals.
- Benefits: faster incremental builds, clear ownership, enforced boundaries and real `internal` visibility.
- Convention plugins in an included `build-logic` build keep Gradle config the same in every module.

### By layer or by feature

```text
By layer                    By feature, layers inside
:app                        :app
:presentation               :feature:profile:presentation
:domain     (kotlin jvm)    :feature:profile:domain  (kotlin jvm)
:data                       :feature:profile:data
                            :core:domain  :core:data  :core:network
```

By layer is simple and fine for small and medium apps. By feature scales better for large teams, because each team owns its slice.

### A pure Kotlin domain module

```kotlin
// domain/build.gradle.kts
plugins {
    alias(libs.plugins.kotlin.jvm)
}

dependencies {
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.javax.inject)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
```

Now the compiler enforces the Dependency Rule. Importing `android.content.Context` in `:domain` fails to build.

> **Pitfall:** Do not split into twenty modules on day one. Each module adds Gradle config and build overhead. Start with packages, then extract modules when build times or team boundaries hurt.

:::check
Q: `:feature:cart` needs to open the product screen from `:feature:product`. Should it depend on `:feature:product`?
A: No, features should not depend on each other. Depend on a small `:feature:product:api` module with the route, or let `:app` wire navigation between features.
Q: A stateless `GetUserProfileUseCase` is marked `@Singleton`. Is that a bug?
A: Not a crash, but wasteful: it pins the object and its dependencies in memory for the app's life. Stateless classes can stay unscoped.
Q: Interview: In a modular Clean Architecture app, which module sees both `UserRepository` and `UserRepositoryImpl`, and why?
A: The data module, which declares the impl and its `@Binds`, and the `:app` module, which builds the whole Hilt graph. Presentation and domain see only the interface.
:::

## Testing ViewModels and anti-patterns

How to unit test ViewModels and reducers with coroutines, fakes and Turbine, plus the mistakes that show up in code review.

:::tldr
- Replace `Dispatchers.Main` with a `MainDispatcherRule`; `runTest` then controls `delay` and `debounce` with virtual time.
- Prefer fakes over mocks; test reducers as plain functions and flows with Turbine.
- A `stateIn(WhileSubscribed)` flow needs a collector in `backgroundScope` before it does anything.
:::

### The setup

`viewModelScope` runs on `Dispatchers.Main`. JVM tests have no main looper, so you swap Main for a test dispatcher.

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

When Main is a `TestDispatcher`, `runTest` shares its scheduler. So `advanceTimeBy` and `advanceUntilIdle` also control `delay` and `debounce` inside the ViewModel.

### Fakes over mocks

Google recommends fakes: small working implementations you control.

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

Fake-based tests read like real usage and do not break when call order changes. Mocks (MockK, Mockito) are fine for one interaction check, but heavy mocking ties tests to implementation details.

### Testing a reducer

```kotlin
@Test
fun `blank query resets state`() {
    val start = SearchState(query = "kot", items = listOf(Item("1", "Kotlin")))
    val result = reduce(start, SearchAction.QueryChanged(""))
    assertEquals(SearchState(query = ""), result)
}
```

No coroutines and no rules. This is MVI's biggest testing win.

### Testing a ViewModel with Turbine

```kotlin
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
        advanceTimeBy(301); runCurrent()
        assertEquals(repo.results, expectMostRecentItem().items) // loading may be conflated
        cancelAndIgnoreRemainingEvents()
    }
    assertEquals(listOf("kot"), repo.queries)
}
```

[Turbine](https://github.com/cashapp/turbine) gives `test { awaitItem() }` for flows. It fails if an item does not arrive in time or unconsumed events remain.

> **Pitfall:** `StateFlow` conflates. Two updates without a suspension point between them may reach the collector as one. Assert on the states you care about, not on every frame.

### Testing stateIn with WhileSubscribed

A `stateIn(WhileSubscribed)` flow does nothing until someone collects. Start a collector in `backgroundScope`.

```kotlin
@Test
fun `results appear after debounce`() = runTest {
    repo.results = listOf(Item("1", "Kotlin"))
    val vm = SearchViewModel(repo, SavedStateHandle())
    backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { vm.uiState.collect() }
    vm.onQueryChange("kot")
    advanceTimeBy(301); runCurrent()
    assertEquals(SearchResults.Success(repo.results), vm.uiState.value.results)
}
```

`backgroundScope` is cancelled at the end of `runTest`, so the endless collector does not hang the test. Test the stateless Screen separately with `createComposeRule()` and a hand-made `UiState`.

### Anti-patterns

- **Context, View or Activity in a ViewModel.** It outlives the Activity and leaks it. Inject a wrapper that uses the application context.
- **Public `MutableStateFlow`.** Anyone can change state. Expose `asStateFlow()`.
- **Business logic in composables.** Hard to test, and reruns on recomposition.
- **God ViewModels.** Split by screen, extract use cases, or use plain state holder classes.
- **One ViewModel shared by unrelated screens** as a data bus. Share through a repository. A nav-graph-scoped ViewModel for a real multi-step flow is fine.
- **`LiveData` in domain or data.** Use `Flow` and `suspend` below the UI.
- **Passing a ViewModel into child composables.** Pass state and lambdas.
- **Swallowing `CancellationException`** with `catch (e: Exception)` or `runCatching`.
- **`GlobalScope` for screen work.** It is never cancelled.
- **Mutable collections in state.** Compose cannot see changes made inside a `MutableList`.

> **Pitfall:** Calling `viewModel.loadData()` from `LaunchedEffect(Unit)` reloads after every rotation, because the effect runs again in the new composition. Start loading from the ViewModel (`init` or `stateIn`).

:::check
Q: A test calls `vm.onQueryChange("kot")` and `advanceTimeBy(301)`, but `vm.uiState.value.results` is still `Idle`. The ViewModel uses `stateIn(WhileSubscribed)`. What is missing?
A: A collector. With no subscriber the upstream never starts; launch `vm.uiState.collect()` in `backgroundScope` first.
Q: Without `MainDispatcherRule`, what happens when a test creates a ViewModel that launches in `viewModelScope`?
A: It fails because `Dispatchers.Main` has no Android main looper on the JVM. The rule replaces Main with a test dispatcher.
Q: Interview: How do you test a ViewModel that uses `viewModelScope` and `debounce`?
A: Swap Main with a `MainDispatcherRule`, run the test in `runTest` so virtual time also drives the ViewModel, and move time with `advanceTimeBy` or `advanceUntilIdle`. Use fake repositories and Turbine to assert the states.
:::

## Review and cheat sheet

The whole topic on one screen, plus exercises and references for review day.

:::tldr
- Layers: UI plus ViewModel, optional domain, data; Clean flips the domain-data arrow with interfaces.
- One immutable `UiState` in a `StateFlow`, one-way data flow, events as state where possible.
- MVI adds typed actions, a pure reducer and explicit effects; pick it when the screen's complexity pays for it.
:::

### Cheat sheet

- **Why:** config changes, process death, async work, testability.
- **Google layers:** UI (composables + ViewModel), optional domain (use cases), data (repositories + data sources). UI to domain to data.
- **UDF:** state down, events up. One owner (SSOT) per piece of data; offline-first means the database is the SSOT.
- **Clean circles:** Entities, Use Cases, Interface Adapters, Frameworks and Drivers. Source dependencies point inward only.
- **Clean on Android:** presentation and data both depend on a pure Kotlin domain. Domain owns repository interfaces; data implements; Hilt `@Binds` wires.
- **Models:** DTO in data, domain model in domain, UI model in presentation. Mappers live in the outer layer of each boundary.
- **Errors:** data maps exceptions to a sealed `DomainError`; presentation maps that to a string resource. Never swallow `CancellationException`.
- **Use cases:** one action, `operator fun invoke`, stateless. Skip pass-throughs.
- **ViewModel:** lives in a `ViewModelStore`, survives rotation, not process death. `viewModelScope` = `SupervisorJob` + `Main.immediate`.
- **SavedStateHandle:** small Bundle-friendly state, `getStateFlow(key, default)`, `toRoute<T>()` for nav args.
- **Creation:** `hiltViewModel()`, `by viewModels()`, or `viewModelFactory { initializer { } }` with `CreationExtras`.
- **State:** private `MutableStateFlow`, public `StateFlow`, change with `update { }`.
- **Derived:** `combine(...).stateIn(viewModelScope, WhileSubscribed(5_000), initial)`.
- **Collect:** `collectAsStateWithLifecycle()` or `repeatOnLifecycle(STARTED)`.
- **Events:** state + "shown" callback; else buffered `Channel` collected on `Main.immediate`. Never replay.
- **MVI:** Action -> pure reducer -> State. Side effects outside, results back as actions.
- **Search:** `debounce` + `flatMapLatest`, or cancel the previous `Job`.
- **Paging:** `Pager(...).flow.cachedIn(viewModelScope)`, separate from `UiState`.
- **Testing:** `MainDispatcherRule`, `runTest`, fakes, Turbine, `backgroundScope` collector for `stateIn`.
- **Never:** Context in ViewModel, public `MutableStateFlow`, logic in composables, `LiveData` below UI, `GlobalScope`.

### Practice exercises

1. Build a login screen in Google-style MVVM: one `UiState`, live validation, a loading button, and an error snackbar using events as state. Make the email survive process death and check it with `adb shell am kill`.
2. Rebuild the same login screen in MVI with a sealed `LoginAction`, a pure reducer and a `LoginEffect` for navigation. Write five reducer tests with no coroutines.
3. Add "recent searches" stored in Room to the MVVM search example. Show them when the query is blank. Write a Turbine test with a fake repository.
4. Add Paging 3 to a feed: full-screen loader on first load, inline retry footer on append error, and an empty state. Keep `PagingData` out of `UiState`.
5. Refactor the search example to Clean Architecture: move `SearchRepository` and a domain `Item` into a pure `kotlin("jvm")` `:domain` module, add a DTO and mapper in `:data`, map `IOException` to a sealed `DomainError`, and map that to a string resource in the ViewModel. Confirm that importing `android.content.Context` in `:domain` fails to compile.

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
- [The Clean Architecture, Robert C. Martin (2012)](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html)

:::check
Q: A ViewModel holds the query in `SavedStateHandle`, results in a `StateFlow` built with `stateIn`, and the selected filter in a plain `var`. After process death, which come back?
A: The query comes back from saved state and the results are rebuilt from it. The plain `var` filter is lost because it is not saved anywhere.
Q: Your use case imports a Room `@Entity` class to read one field. Name the rule broken and the fix.
A: The Dependency Rule: domain now knows a data detail. Map the entity to a domain model in the data layer and have the repository interface return that model.
Q: Interview: Describe how state and events flow through an MVI screen built on Clean Architecture, from a click to a repository and back.
A: The UI dispatches an action; the reducer updates state; a side effect calls a use case, which calls a repository interface implemented in data. The result returns as a domain value, becomes a result action, the reducer produces new state, and the UI renders the new `StateFlow` value.
:::
