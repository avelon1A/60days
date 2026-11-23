Kotlin is the main language for Android, and senior interviews test it deeply. Interviewers want more than syntax. They want to know why the language works the way it does and what the compiler produces. These notes cover the language itself in the Kotlin 2.x (K2 compiler) era. Coroutines, Flow and Compose have their own notes, so here we only touch them where the language features they use are explained.

## Type System and Null Safety

### Nullable and non-null types

Every type in Kotlin has two forms. `String` can never hold `null`. `String?` can. The compiler checks this at compile time, so most `NullPointerException`s become compile errors.

```kotlin
var name: String = "Ana"
// name = null            // compile error
var nick: String? = null

val len1 = nick?.length          // safe call: Int?
val len2 = nick?.length ?: 0     // Elvis: default when null
val len3 = nick!!.length         // not-null assertion: throws NPE if null
nick?.let { println(it.uppercase()) } // run block only when non-null
```

- `?.` returns `null` instead of calling the member when the receiver is null.
- `?:` (Elvis) gives a fallback. The right side can be `return` or `throw`, because those are expressions of type `Nothing`.
- `!!` says "I know better than the compiler". Use it rarely. Each `!!` is a possible crash.
- `as?` is a safe cast. It returns `null` instead of throwing `ClassCastException`.

> **Under the hood:** Nullability is a compile-time feature. At runtime `String` and `String?` are the same `java.lang.String`. The compiler adds `@NotNull`/`@Nullable` annotations and inserts checks like `Intrinsics.checkNotNullParameter` on public function parameters so Java callers fail fast.

### Any, Unit and Nothing

| Type | Meaning | Java equivalent |
|---|---|---|
| `Any` | Root of all non-null types | `Object` |
| `Any?` | Root of every type | `Object` (nullable) |
| `Unit` | "No useful value". A real singleton object | `void` |
| `Nothing` | "This never returns". Has no instances | none |
| `Nothing?` | The type of the `null` literal | none |

`Unit` is a real object. That is why a lambda `() -> Unit` can be stored and passed around like any other function type. When a function returns `Unit`, the JVM bytecode still uses `void` where possible.

`Nothing` is a subtype of every type. A function that always throws returns `Nothing`. This lets the compiler know code after it is unreachable.

```kotlin
fun fail(msg: String): Nothing = throw IllegalStateException(msg)

val user = findUser() ?: fail("no user") // user is smart-cast to non-null
val x: Int = TODO()                      // TODO() returns Nothing, so it fits any type
```

### Platform types

When you call Java code that has no nullability annotations, Kotlin cannot know if a value is nullable. It gives you a platform type, shown in IDE hints as `String!`. You may treat it as `String` or `String?`. If you treat it as `String` and it is null, you get an NPE at that point.

```kotlin
val s = javaObj.getName()    // type is String! (platform)
val safe: String? = javaObj.getName()  // best: be explicit at the boundary
```

> **Tip:** At the Java boundary, always declare the type explicitly. That turns an unknown platform type into a known Kotlin type and puts the check in one place.

> **Note:** Java code annotated with `@Nullable`/`@NonNull` (AndroidX, JetBrains, JSpecify and others) is read as real Kotlin nullable or non-null types, not platform types.

### Smart casts

After a type check or null check, the compiler treats the variable as the narrower type. No manual cast needed.

```kotlin
fun describe(x: Any): String = when (x) {
    is String -> "String of length ${x.length}"   // x is String here
    is Int -> "Int doubled ${x * 2}"
    else -> "Unknown"
}

fun greet(name: String?) {
    if (name == null) return
    println(name.length)  // smart cast to String
}
```

Smart casts only work when the compiler can prove the value cannot change between the check and the use. They work on `val` locals, `val` properties without custom getters in the same module, and `var` locals that are not captured in a lambda that modifies them. They do not work on `open` properties, custom getters, or `var` class properties, because another thread or a subclass could change them.

The K2 compiler made smart casts smarter. For example, it remembers checks stored in local variables, merges `is` checks across `||` to a common supertype, and handles more cases inside lambdas and loops.

```kotlin
fun process(a: Any) {
    val isText = a is String
    if (isText) println(a.length) // K2: smart cast works through the local
}
```

> **Pitfall:** `if (this.name != null) name.length` fails to compile when `name` is a `var` property. Copy it to a local `val` first, or use `name?.let { }`.

## Variables and Properties

### val vs var

- `val` is read-only. You cannot reassign it. It is like a Java `final` variable.
- `var` is mutable.
- `val` does not mean immutable. `val list = mutableListOf(1)` can still be changed with `list.add(2)`. Only the reference is fixed.
- `const val` is a compile-time constant. It must be a primitive or `String`, declared at top level, in an `object`, or in a companion. Its value is inlined at use sites.

### Properties and backing fields

A Kotlin property is a field plus a getter (and a setter for `var`). You never declare the field yourself. Inside an accessor, the keyword `field` refers to the backing field.

```kotlin
class User {
    var name: String = ""
        set(value) {
            field = value.trim()     // write the backing field
        }

    val isValid: Boolean
        get() = name.isNotEmpty()    // computed: no backing field at all

    var counter = 0
        private set                  // public getter, private setter
}
```

The compiler creates a backing field only if at least one accessor uses the default implementation or refers to `field`. `isValid` above has no field. It is computed each time.

> **Pitfall:** Writing `set(value) { name = value }` inside the setter of `name` calls the setter again and causes infinite recursion and a `StackOverflowError`. Use `field = value`.

A common Android pattern is a private mutable backing property and a public read-only view:

```kotlin
private val _state = MutableStateFlow(UiState())
val state: StateFlow<UiState> = _state.asStateFlow()
```

### lateinit vs lazy

| | `lateinit var` | `val by lazy` |
|---|---|---|
| Keyword | `var` only | `val` only |
| Types | Non-null, non-primitive | Any type, including nullable and primitive |
| Who sets it | You, later, from outside | The lambda, on first access |
| Thread safety | None | Synchronized by default |
| Check if set | `::prop.isInitialized` | `lazyValue.isInitialized()` on the `Lazy` object |
| Failure | `UninitializedPropertyAccessException` | Exception from the lambda, retried next access |

Use `lateinit` for values injected or set in a lifecycle callback, like a field set by Dagger/Hilt or in `onCreate`. Use `lazy` for expensive values you want to compute once, on first use.

```kotlin
class ProfileActivity : AppCompatActivity() {
    @Inject lateinit var analytics: Analytics
    private val adapter by lazy { ProfileAdapter(::onItemClick) }

    fun log() {
        if (::analytics.isInitialized) analytics.track("open")
    }
}
```

### How lazy is implemented

`lazy { }` returns a `Lazy<T>` object. The property getter calls `lazy.getValue()`. There are three modes:

- `LazyThreadSafetyMode.SYNCHRONIZED` (default): uses double-checked locking. Only one thread runs the initializer.
- `LazyThreadSafetyMode.PUBLICATION`: several threads may run the initializer, but the first result to be published wins.
- `LazyThreadSafetyMode.NONE`: no locking. Fastest. Safe only if one thread uses it, such as the Android main thread.

A simplified version of the synchronized implementation:

```kotlin
private object UNINITIALIZED

class SimpleSyncLazy<T>(initializer: () -> T) : Lazy<T> {
    private var init: (() -> T)? = initializer
    @Volatile private var _value: Any? = UNINITIALIZED
    private val lock = Any()

    override val value: T
        get() {
            val v1 = _value
            if (v1 !== UNINITIALIZED) return v1 as T     // fast path, no lock
            return synchronized(lock) {
                val v2 = _value
                if (v2 !== UNINITIALIZED) v2 as T
                else init!!().also { _value = it; init = null } // free the lambda
            }
        }
    override fun isInitialized() = _value !== UNINITIALIZED
}
```

> **Under the hood:** The sentinel `UNINITIALIZED` object lets `lazy` store `null` as a valid value. Setting `init = null` after use lets the lambda and everything it captured be garbage collected.

> **Tip:** For UI-only state on the main thread, `lazy(LazyThreadSafetyMode.NONE) { }` avoids the lock cost. The saving is small; use it in hot paths, not everywhere.

## Functions

### Default and named arguments

```kotlin
fun connect(host: String, port: Int = 443, secure: Boolean = true) { }

connect("api.example.com")
connect("api.example.com", secure = false)   // skip port by naming
```

Default arguments replace most Java overloads. Named arguments make calls with many booleans readable.

> **Under the hood:** The compiler generates one extra synthetic method `connect$default(host, port, secure, mask, marker)`. The `mask` is a bit field telling which arguments were omitted. Java does not see the defaults unless you add `@JvmOverloads`.

### Single-expression functions and local functions

```kotlin
fun square(x: Int) = x * x

fun validate(user: User) {
    fun check(value: String, field: String) {   // local function
        require(value.isNotEmpty()) { "$field empty for ${user.id}" }
    }
    check(user.name, "name")
    check(user.email, "email")
}
```

### Extension functions

Extensions add functions to a type without inheriting from it or changing its source.

```kotlin
fun String.isEmail(): Boolean = contains("@") && contains(".")
val String.lastChar: Char get() = this[length - 1]   // extension property

"a@b.com".isEmail()
```

An extension compiles to a static method. The receiver becomes the first parameter. If the file is `StringUtils.kt`, Java sees:

```java
public final class StringUtilsKt {
    public static final boolean isEmail(@NotNull String $this$isEmail) { ... }
}
```

Because of this:

- Extensions are resolved statically, by the declared type of the variable, not the runtime type. They are not virtual.
- If a class has a member with the same signature, the member always wins.
- Extensions cannot access `private` or `protected` members of the receiver.
- Extension properties cannot have a backing field. They must use getters.

```kotlin
open class Shape
class Circle : Shape()
fun Shape.name() = "Shape"
fun Circle.name() = "Circle"

val s: Shape = Circle()
println(s.name())   // prints "Shape": static dispatch on declared type
```

> **Interview:** "Can extension functions be overridden?" No. They are static. Dispatch is based on the compile-time type of the receiver.

You can also write extensions on nullable types (`fun String?.orDash() = this ?: "-"`) and on companion objects (`fun MyClass.Companion.create()`).

### Infix functions

A member or extension with one parameter can be marked `infix` so you can call it without dot and parentheses.

```kotlin
infix fun Int.pow(exp: Int): Int = (1..exp).fold(1) { acc, _ -> acc * this }
val x = 2 pow 10          // 1024
val pair = "key" to 42    // `to` is an infix function from the stdlib
```

### Operator overloading

You overload a fixed set of operators by declaring functions with specific names and the `operator` modifier.

| Expression | Function |
|---|---|
| `a + b` | `a.plus(b)` |
| `a += b` | `a.plusAssign(b)` or `a = a.plus(b)` |
| `a[i]` / `a[i] = v` | `get(i)` / `set(i, v)` |
| `a(x)` | `a.invoke(x)` |
| `x in a` | `a.contains(x)` |
| `a < b` | `a.compareTo(b) < 0` |
| `a..b` / `a..<b` | `rangeTo` / `rangeUntil` |
| `val (x, y) = a` | `component1()`, `component2()` |
| `for (x in a)` | `iterator()` |
| `-a`, `!a`, `a++` | `unaryMinus`, `not`, `inc` |

```kotlin
data class Vec(val x: Int, val y: Int) {
    operator fun plus(o: Vec) = Vec(x + o.x, y + o.y)
    operator fun times(k: Int) = Vec(x * k, y * k)
}
val v = Vec(1, 2) + Vec(3, 4) * 2   // Vec(7, 10)
```

> **Pitfall:** `==` maps to `equals`, which you override normally, not with `operator`. And `===` cannot be overloaded.

### tailrec

`tailrec` tells the compiler to turn a tail-recursive function into a loop. No stack frames pile up.

```kotlin
tailrec fun gcd(a: Int, b: Int): Int = if (b == 0) a else gcd(b, a % b)
```

The recursive call must be the very last operation. It cannot be inside `try`/`catch`/`finally`, and the function cannot be `open`. If the call is not in tail position, the compiler warns and does not optimize.

### varargs

```kotlin
fun log(vararg tags: String) = tags.joinToString()
val arr = arrayOf("a", "b")
log("x", *arr)   // spread operator copies the array
```

## Lambdas and Inline Functions

### Function types and lambdas

Functions are first-class. A function type looks like `(Int, Int) -> Int`. A lambda is a function literal.

```kotlin
val sum: (Int, Int) -> Int = { a, b -> a + b }
val isEven: (Int) -> Boolean = { it % 2 == 0 }   // `it` for single param
val ref = ::println                              // function reference
val greet: String.() -> String = { "Hi $this" }  // lambda with receiver

fun apply(x: Int, op: (Int) -> Int) = op(x)      // higher-order function
apply(5) { it * 3 }                               // trailing lambda syntax
```

A higher-order function takes or returns a function. If the last parameter is a function, you can pass the lambda outside the parentheses.

Lambdas capture variables from the enclosing scope. Unlike Java, they can modify captured `var`s.

> **Under the hood:** A captured `var` is wrapped in a `Ref` object (like `Ref.IntRef`) so the lambda and the outer function share it. Non-inline lambdas become objects implementing `Function0`, `Function1` and so on, or are compiled via `invokedynamic` (the default since Kotlin 2.0 on the JVM). Lambdas that capture nothing can be reused as singletons.

### Why inline exists

Every non-inline lambda costs an object allocation (if it captures) and a virtual `invoke` call. For small utilities called in loops, that adds up. `inline` copies the function body and the lambda body into the call site.

```kotlin
inline fun <T> measure(block: () -> T): T {
    val start = System.nanoTime()
    return block().also { println("took ${System.nanoTime() - start}") }
}
```

After inlining, the call site contains the timing code and the block code directly. No `Function0` object, no `invoke`.

Inline lambdas also allow non-local returns. A plain `return` inside the lambda returns from the outer function.

```kotlin
fun findAdmin(users: List<User>): User? {
    users.forEach { if (it.isAdmin) return it }   // returns from findAdmin
    return null
}

users.forEach { if (it.isAdmin) return@forEach }  // labeled return: like `continue`
```

### noinline and crossinline

- `noinline`: do not inline this lambda parameter. Needed when you want to store the lambda or pass it to a non-inline function.
- `crossinline`: inline the lambda, but forbid non-local `return`. Needed when the lambda is called from another context, such as inside an object or another lambda (for example a `Runnable`).

```kotlin
inline fun runBoth(a: () -> Unit, noinline b: () -> Unit) {
    a()
    callbacks.add(b)          // b must be a real object to be stored
}

inline fun postToMain(crossinline action: () -> Unit) {
    handler.post { action() } // runs later in another lambda: no non-local return
}
```

> **Tip:** Inline only small functions that take lambdas. Inlining big functions bloats bytecode. The compiler warns when inline gives no benefit (no function-type parameters).

> **Pitfall:** A public inline function cannot use private or internal members of its class, because its body is copied into callers in other modules. Use `@PublishedApi internal` if needed.

### Reified type parameters

Normally generic types are erased at runtime. You cannot write `x is T`. In an inline function you can mark a type parameter `reified`. Because the body is copied to the call site, the real type is known there.

```kotlin
inline fun <reified T> Any.isA(): Boolean = this is T

inline fun <reified T : Activity> Context.start() =
    startActivity(Intent(this, T::class.java))

inline fun <reified T> Gson.fromJson(json: String): T =
    fromJson(json, object : TypeToken<T>() {}.type)

context.start<SettingsActivity>()
```

> **Interview:** "Why can reified only be used with inline?" Because the type information exists only at the call site. Inlining copies the body there, and the compiler substitutes the concrete class. A normal function has one compiled body for all `T`.

## Scope Functions

The five scope functions run a block on an object. They differ in two ways: how you refer to the object (`this` or `it`) and what they return (the object or the lambda result).

| Function | Object ref | Returns | Typical use |
|---|---|---|---|
| `let` | `it` | Lambda result | Null checks with `?.let`, transforming a value |
| `run` | `this` | Lambda result | Configure and compute a result |
| `with` | `this` | Lambda result | Many calls on one object (not an extension) |
| `apply` | `this` | The object | Builder-style configuration |
| `also` | `it` | The object | Side effects like logging or validation |

```kotlin
val length = name?.let { it.trim().length } ?: 0

val intent = Intent(ctx, DetailActivity::class.java).apply {
    putExtra("id", id)
    flags = Intent.FLAG_ACTIVITY_NEW_TASK
}

val user = repository.load(id).also { Log.d("TAG", "loaded $it") }

val summary = with(order) { "$id: ${items.size} items, total $total" }

val result = service.run { connect(); fetch() }
```

### Quick decision guide

- Need the object back? Use `apply` (configuring) or `also` (side effect).
- Need a computed result? Use `let` (with `it`), `run` (with `this`), or `with` (non-extension).
- Working with a nullable? Use `?.let` or `?.run`.
- Also useful: `takeIf { }` returns the object or `null`, and `takeUnless { }` does the opposite.

> **Pitfall:** Nesting scope functions makes `it` and `this` confusing. If you nest, rename `it` (`user -> ...`) or use plain local variables.

> **Pitfall:** `x?.let { a() } ?: b()` runs `b()` also when `a()` returns `null`, not only when `x` is null. Use `if`/`else` when the lambda may return null.

> **Under the hood:** All scope functions are `inline`, so they cost nothing at runtime. They also use contracts (`callsInPlace`), which lets you initialize a `val` inside them.

## Classes and Objects

### Basics

- Classes are `final` by default. Use `open` to allow subclassing and `open` on members to allow overriding.
- `override` members are open unless marked `final override`.
- Primary constructor parameters with `val`/`var` become properties.
- `init` blocks run in order with property initializers.

```kotlin
open class Base(val id: String) {
    init { require(id.isNotBlank()) }
    open fun describe() = "Base $id"
}
class Child(id: String, val extra: Int) : Base(id) {
    override fun describe() = "Child $id $extra"
}
```

> **Pitfall:** Do not call `open` members from a constructor or `init`. The subclass override runs before the subclass properties are initialized, so it may see `null` in a non-null property.

### Data classes

A `data class` gets `equals`, `hashCode`, `toString`, `copy`, and `componentN` functions generated from the primary constructor properties only.

```kotlin
data class User(val id: Long, val name: String) {
    var lastSeen: Long = 0   // NOT part of equals/hashCode/toString/copy
}
val a = User(1, "Ana")
val b = a.copy(name = "Bea")   // shallow copy
val (id, name) = a             // destructuring
```

Rules: the primary constructor needs at least one parameter, and all must be `val` or `var`. Data classes cannot be `open`, `abstract`, `sealed` or `inner`.

> **Pitfall:** `copy()` is shallow. Copying a data class holding a `MutableList` shares the same list between both copies.

> **Note:** Since Kotlin 2.0.20 the compiler warns when a data class has a private constructor but a public `copy()`, because `copy` would bypass the constructor. Annotate the class with `@ConsistentCopyVisibility` to make `copy` match the constructor visibility.

### Sealed classes and interfaces

A sealed type has a closed set of direct subtypes, all known at compile time. They must be in the same module and package. This makes `when` exhaustive without `else`.

```kotlin
sealed interface UiState {
    data object Loading : UiState
    data class Success(val items: List<Item>) : UiState
    data class Error(val message: String) : UiState
}

fun render(state: UiState) = when (state) {   // no else needed
    UiState.Loading -> showSpinner()
    is UiState.Success -> showList(state.items)
    is UiState.Error -> showError(state.message)
}
```

- Sealed class: subtypes share state and a constructor. A class can extend only one.
- Sealed interface: a class can implement several. Enums can implement them too. Prefer sealed interfaces unless you need shared state.
- `data object` (Kotlin 1.9+) gives a singleton a readable `toString` ("Loading") and proper `equals`.

> **Tip:** Avoid `else` in a `when` over a sealed type. Then adding a new subtype causes compile errors everywhere you forgot to handle it. That is the whole point.

### Enum classes

```kotlin
enum class Priority(val weight: Int) {
    LOW(1), HIGH(10) {
        override fun label() = "Urgent"
    };
    open fun label() = name.lowercase()
}
Priority.entries.forEach { println(it) }   // prefer entries over values()
Priority.valueOf("LOW")
```

Use `entries` (Kotlin 1.9+). It returns a pre-allocated immutable list. `values()` creates a new array on every call.

Enum vs sealed: enum constants are single instances with the same shape. Sealed subtypes can be different classes with different data and many instances.

### Value classes

A value class wraps one value with no runtime object in most cases. It gives type safety for free.

```kotlin
@JvmInline
value class UserId(val raw: String)

fun load(id: UserId) { }   // cannot pass a random String by mistake
```

At runtime `UserId` is usually just a `String`. It is boxed (a real object is created) when used as a nullable type, as a generic type argument, or through an interface it implements.

> **Under the hood:** Functions taking value classes get mangled JVM names like `load-AbC123(String)`. This avoids clashes between `load(UserId)` and `load(String)`, but makes them hard to call from Java. Use `@JvmName` to give a Java-friendly name.

### object, companion object, anonymous objects

- `object Foo` is a singleton. It is created lazily and thread-safely on first access (via the JVM class initialization).
- `companion object` belongs to a class and holds "static-like" members. It is still a real object and can implement interfaces.
- `object : Listener { }` is an anonymous object, like a Java anonymous class.

```kotlin
class Repo private constructor() {
    companion object Factory : Creator<Repo> {
        const val TAG = "Repo"
        override fun create() = Repo()
    }
}
Repo.create()
```

### Nested vs inner classes

- A nested class (default) has no reference to the outer instance. Like a Java `static` nested class.
- An `inner` class holds a reference to the outer instance and can access its members with `this@Outer`.

> **Pitfall:** An `inner` class or anonymous object inside an Activity holds the Activity. If it outlives the Activity (for example a long-running callback) it leaks memory. Prefer nested classes on Android.

### Interfaces

Interfaces can have properties (abstract or with getters) and default method bodies. They cannot hold state (no backing fields).

## Delegation

### Class delegation

`by` lets a class implement an interface by forwarding calls to another object. This is the language-level support for "composition over inheritance".

```kotlin
class LoggingList<T>(private val inner: MutableList<T> = mutableListOf()) :
    MutableList<T> by inner {
    override fun add(element: T): Boolean {
        println("add $element")
        return inner.add(element)
    }
}
```

The compiler generates every `MutableList` method to call `inner`, except the ones you override.

> **Pitfall:** The delegate does not know about your overrides. If `inner.addAll` internally calls `add`, it calls its own `add`, not yours. This is not like inheritance.

### Delegated properties

`val x by delegate` makes the getter call `delegate.getValue(thisRef, property)` and a `var` setter call `setValue`.

```kotlin
class Prefs(private val sp: SharedPreferences) {
    var token: String by StringPref(sp, "token")
}

class StringPref(val sp: SharedPreferences, val key: String) :
    ReadWriteProperty<Any?, String> {
    override fun getValue(thisRef: Any?, property: KProperty<*>) =
        sp.getString(key, "") ?: ""
    override fun setValue(thisRef: Any?, property: KProperty<*>, value: String) =
        sp.edit().putString(key, value).apply()
}
```

### Standard delegates

```kotlin
import kotlin.properties.Delegates

var name: String by Delegates.observable("init") { _, old, new ->
    println("$old -> $new")              // runs after change
}
var age: Int by Delegates.vetoable(0) { _, _, new -> new >= 0 } // reject negatives
var id: Int by Delegates.notNull()       // like lateinit, works for primitives

class Config(map: Map<String, Any?>) {
    val host: String by map              // reads map["host"]
    val port: Int by map
}

var alias: String by this::name          // delegate to another property
```

- `lazy`: compute once on first read.
- `observable`: callback after every change.
- `vetoable`: callback before change; return `false` to reject.
- `notNull`: late init, any type, throws if read before set.
- Map delegation: property name is the map key. Good for parsed JSON or config.

> **Under the hood:** For each delegated property the compiler creates a hidden field `name$delegate` holding the delegate, plus a getter that calls `getValue`. Kotlin 2.x avoids creating `KProperty` reflection objects in many cases when the delegate does not use them, for example with `lazy`.

You can also intercept delegate creation with `provideDelegate`, which runs once when the property is created. Useful for validating property names.

## Generics

### Basics and constraints

```kotlin
class Box<T>(val value: T)
fun <T : Comparable<T>> maxOf(a: T, b: T) = if (a > b) a else b

fun <T> copyIfValid(x: T) where T : CharSequence, T : Comparable<T> { }
```

An unconstrained `T` has upper bound `Any?`, so it can be nullable. Write `T : Any` to forbid null.

### Variance: out and in

By default generic types are invariant. `List<String>` is a subtype of `List<Any>` only because `List` is declared `List<out E>`.

- `out T` (covariant): the type only produces `T`. `Producer<Cat>` is a `Producer<Animal>`. You can return `T`, not accept it.
- `in T` (contravariant): the type only consumes `T`. `Consumer<Animal>` is a `Consumer<Cat>`. You can accept `T`, not return it.
- No modifier (invariant): both read and write. No subtyping between `Box<Cat>` and `Box<Animal>`.

Memory trick: Producer `out`, Consumer `in`. Same as Java's PECS (`? extends` / `? super`).

```kotlin
interface Source<out T> { fun next(): T }
interface Sink<in T> { fun put(item: T) }

val animals: Source<Animal> = catSource   // ok: out
val catSink: Sink<Cat> = animalSink        // ok: in
```

### Declaration-site vs use-site variance

- Declaration-site: you write `out`/`in` on the class type parameter. It applies everywhere. Java does not have this.
- Use-site (type projection): you write it at a specific usage when the class itself is invariant.

```kotlin
fun copy(from: Array<out Any>, to: Array<in Any>) {
    for (i in from.indices) to[i] = from[i]
}
```

`Array<out Any>` means "I will only read from this". Calling `from[0] = x` would not compile.

### Star projection

`List<*>` means "a list of some specific type I do not know". You can read items as `Any?`. You cannot write anything (except `null` in some cases). It is like Java's `List<?>`.

```kotlin
fun printAll(items: List<*>) = items.forEach { println(it) }
if (x is List<*>) { }        // allowed: erased check
// if (x is List<String>)    // not allowed: cannot check erased type
```

### Type erasure

On the JVM, generic type arguments are removed at runtime. `List<String>` and `List<Int>` are both just `List`. This is why you cannot check `is List<String>` and why you need `reified` or pass a `Class<T>`/`KClass<T>` explicitly.

> **Interview:** "What does `@UnsafeVariance` do?" It suppresses the variance check on a parameter. The stdlib uses it in `List<out E>.contains(element: @UnsafeVariance E)` because `contains` only compares and never stores.

## Collections and Sequences

### Read-only vs mutable

| Read-only interface | Mutable interface | Factory |
|---|---|---|
| `List<T>` | `MutableList<T>` | `listOf` / `mutableListOf` |
| `Set<T>` | `MutableSet<T>` | `setOf` / `mutableSetOf` |
| `Map<K, V>` | `MutableMap<K, V>` | `mapOf` / `mutableMapOf` |

Read-only is not immutable. `List<T>` just has no methods to change it. The same object may be a `MutableList` (or a Java `ArrayList`) underneath, and someone else can change it.

```kotlin
val mutable = mutableListOf(1, 2)
val readOnly: List<Int> = mutable
mutable.add(3)
println(readOnly)   // [1, 2, 3]: same object
```

> **Tip:** Expose `List<T>` from APIs, keep `MutableList<T>` private. For true immutability use `kotlinx.collections.immutable` (`persistentListOf`), which also helps Compose stability.

> **Under the hood:** On the JVM, `List` and `MutableList` both map to `java.util.List`. A Java method can cast and mutate your "read-only" list. `listOf(a, b)` returns a fixed-size `Arrays.asList` wrapper.

### Common operators

```kotlin
val users: List<User> = repo.all()

users.filter { it.active }.map { it.name }
users.mapNotNull { it.email }               // drop nulls
users.flatMap { it.roles }
users.associateBy { it.id }                 // Map<Id, User>
users.groupBy { it.country }                // Map<Country, List<User>>
users.partition { it.age >= 18 }            // Pair<List, List>
users.sortedByDescending { it.score }.take(10)
users.firstOrNull { it.isAdmin }
users.any { it.banned }; users.all { it.verified }; users.count { it.active }
users.sumOf { it.score }
users.chunked(20); users.windowed(3); users.zip(scores)
users.fold(0) { acc, u -> acc + u.score }
users.distinctBy { it.email }
```

Each operator on an `Iterable` is eager. It runs immediately and creates a new list.

### Sequences and laziness

A `Sequence` is lazy. Operations are not run until a terminal operation (like `toList`, `first`, `sum`) asks for values. Then each element flows through the whole chain one at a time.

```kotlin
val result = (1..1_000_000).asSequence()
    .map { it * 2 }          // intermediate: lazy
    .filter { it % 3 == 0 }  // intermediate: lazy
    .take(5)                 // intermediate: lazy
    .toList()                // terminal: runs now
```

Eager list: `map` creates a list of 1,000,000, `filter` creates another big list, then `take` picks 5. Lazy sequence: the first element goes map, filter, take; then the second; it stops after 5 matches. Only a handful of elements are ever processed.

| | Iterable (List) | Sequence |
|---|---|---|
| Evaluation | Eager, step by step | Lazy, element by element |
| Intermediate collections | One per operation | None |
| Short-circuit (`first`, `take`) | Still processes earlier steps fully | Stops early |
| Overhead | Low per step | Small per element (iterator objects, lambdas not inlined) |
| Best for | Small collections, one or two operations | Large or infinite data, long chains, early exit |

```kotlin
val fib = generateSequence(1 to 1) { (a, b) -> b to a + b }.map { it.first }
fib.take(10).toList()   // infinite sequence, safe because take is lazy
```

> **Pitfall:** A sequence without a terminal operation does nothing. And `sorted()` on a sequence must consume everything before emitting, so it loses the laziness benefit.

> **Note:** Sequences are synchronous and pull-based. `Flow` is the asynchronous, suspending counterpart. See the Coroutines and Flow notes.

### Arrays

`Array<Int>` holds boxed `Integer`s. `IntArray` is a primitive `int[]`. Prefer primitive arrays for performance.

## Equality and Exceptions

### == vs ===

- `==` is structural equality. `a == b` compiles to `a?.equals(b) ?: (b === null)`. It is null-safe.
- `===` is referential equality. True only if both refer to the same object.

```kotlin
val a = User(1, "Ana")
val b = User(1, "Ana")
a == b    // true: data class equals compares properties
a === b   // false: two objects
```

> **Pitfall:** For boxed numbers, `===` is unreliable. `val x: Int? = 127; val y: Int? = 127; x === y` may be true due to the JVM Integer cache, but with 1000 it is false. Never use `===` on numbers.

### equals and hashCode contract

1. If `a == b`, then `a.hashCode() == b.hashCode()` must be true.
2. Equal hash codes do not imply equality.
3. `equals` must be reflexive, symmetric, transitive and consistent.

If you override one, override both. Data classes generate both from primary constructor properties, so the contract holds automatically.

> **Pitfall:** A data class with an `Array` property compares arrays by reference, because arrays do not override `equals`. Use `List` instead, or override `equals`/`hashCode` with `contentEquals`/`contentHashCode`.

> **Pitfall:** Do not put a data class with `var` properties into a `HashSet` or as a `HashMap` key and then change it. Its hash code changes and the set can no longer find it.

### Exceptions

Kotlin has no checked exceptions. You never have to declare or catch anything. `try` is an expression.

```kotlin
val n: Int? = try { s.toInt() } catch (e: NumberFormatException) { null }

require(age >= 0) { "age must be >= 0" }   // IllegalArgumentException
check(isConnected) { "not connected" }     // IllegalStateException
val u = requireNotNull(user) { "no user" } // smart casts to non-null
error("unreachable")                       // throws IllegalStateException
```

For Java callers that expect checked exceptions, add `@Throws(IOException::class)`.

### runCatching and Result

```kotlin
val result: Result<User> = runCatching { api.fetchUser(id) }

result
    .map { it.name }
    .onSuccess { show(it) }
    .onFailure { log(it) }

val name = result.getOrElse { "guest" }
val name2 = result.getOrNull()
```

> **Pitfall:** `runCatching` catches every `Throwable`, including `CancellationException` (breaks coroutine cancellation) and `Error`s like `OutOfMemoryError`. In suspend code, rethrow `CancellationException` or catch specific exceptions instead.

For domain errors, many teams prefer a sealed result type (`sealed interface Outcome { Success, NetworkError, NotFound }`) because it is exhaustive and typed, while `Result` only carries a `Throwable`.

## Visibility and Java Interop

### Visibility modifiers

| Modifier | Top-level declaration | Class member |
|---|---|---|
| `public` (default) | Everywhere | Everywhere |
| `internal` | Same module | Same module |
| `protected` | Not allowed | Subclasses only (not same package, unlike Java) |
| `private` | Same file | Same class |

A module is a set of files compiled together: a Gradle module (or source set), a Maven project. In multi-module Android apps, `internal` is the main tool to hide implementation details of a feature module.

> **Under the hood:** The JVM has no "module" visibility. `internal` members compile to `public` in bytecode, and internal functions get mangled names like `doWork$mylib_release`. Java code can still call them, though awkwardly.

### Java interop annotations

```kotlin
class Analytics {
    companion object {
        @JvmStatic fun get(): Analytics = instance  // Java: Analytics.get()
        @JvmField val VERSION = "1.0"               // Java: Analytics.VERSION (no getter)
        const val TAG = "Analytics"                 // static final, inlined
    }
}

class Dialog @JvmOverloads constructor(
    ctx: Context, title: String = "", cancelable: Boolean = true
)   // Java sees 3 constructors

@file:JvmName("StringUtils")   // first line of file: Java class name instead of FileKt
```

- `@JvmStatic`: generates a real static method in the outer class (also keeps the companion instance method).
- `@JvmField`: exposes the property as a public field, no getter/setter. Not allowed on `private`, `open`, `const` or delegated properties.
- `@JvmOverloads`: generates overloads for default parameters. Common for custom Views: `class MyView @JvmOverloads constructor(ctx: Context, attrs: AttributeSet? = null, defStyle: Int = 0)`.
- `@JvmName`: renames the JVM method or file class. Also solves signature clashes after erasure.
- `@Throws`: declares checked exceptions for Java.

```kotlin
fun List<String>.total(): Int = size
@JvmName("totalInts")
fun List<Int>.total(): Int = sum()   // without @JvmName both erase to total(List)
```

> **Pitfall:** `@JvmOverloads` on custom View constructors passing `defStyleAttr = 0` can drop theme styles for some Material widgets. For Views that extend styled widgets, pass the right default style attr explicitly.

### SAM conversion and fun interface

A SAM (single abstract method) interface can be created from a lambda.

```kotlin
// Java interface: Runnable, View.OnClickListener
button.setOnClickListener { v -> handle(v) }
executor.execute { work() }

// Kotlin interface: must be declared `fun interface` for SAM conversion
fun interface Validator {
    fun validate(input: String): Boolean
}
val notEmpty = Validator { it.isNotEmpty() }
```

Prefer a plain function type `(String) -> Boolean` for Kotlin-only code. Use `fun interface` when you want a named type, Java callers, or extra default methods.

### Other interop notes

- Kotlin getters map to Java `getX()`/`isX()`, and Java getters/setters appear as Kotlin properties.
- Kotlin keywords used as Java names need to be wrapped in backticks when you call them from Kotlin. For example, a Java method named `is()` must be called with the name is wrapped in backtick characters, because `is` is a Kotlin keyword.
- Top-level functions live in a class named `FileNameKt`.
- Default methods in interfaces compile to JVM default methods (controlled by the `-jvm-default` compiler option in recent versions).

## Contracts and DSLs

### Contracts

Contracts tell the compiler facts about a function that it cannot infer. They let smart casts and `val` initialization work through function calls. Writing your own still requires opt-in (`@OptIn(ExperimentalContracts::class)`), but the stdlib uses them widely.

```kotlin
@OptIn(ExperimentalContracts::class)
fun String?.isPresent(): Boolean {
    contract { returns(true) implies (this@isPresent != null) }
    return this != null && isNotEmpty()
}

fun show(s: String?) {
    if (s.isPresent()) println(s.length)  // smart cast works
}
```

```kotlin
@OptIn(ExperimentalContracts::class)
inline fun <R> once(block: () -> R): R {
    contract { callsInPlace(block, InvocationKind.EXACTLY_ONCE) }
    return block()
}

val x: Int
once { x = 42 }   // allowed: compiler knows the block runs exactly once
```

Stdlib examples: `require`, `check`, `requireNotNull`, `isNullOrEmpty`, `let`, `run`, `apply`.

> **Pitfall:** The compiler does not verify contracts. A wrong contract leads to unsafe smart casts and runtime crashes.

### Lambdas with receiver

A lambda of type `T.() -> Unit` runs as if it were a member of `T`. Inside it, `this` is the receiver. This is the core of every Kotlin DSL, including `apply`, `buildString`, Gradle Kotlin DSL and Compose's `Modifier`/scopes.

```kotlin
val html = buildString {      // receiver: StringBuilder
    append("<p>")
    append("Hello")
    append("</p>")
}
```

### Building a type-safe DSL

```kotlin
@DslMarker annotation class MenuDsl

@MenuDsl class Menu { val items = mutableListOf<Item>()
    fun item(title: String, block: Item.() -> Unit = {}) {
        items += Item(title).apply(block)
    }
}
@MenuDsl class Item(val title: String) { var icon: Int = 0; var onClick: () -> Unit = {} }

fun menu(block: Menu.() -> Unit): Menu = Menu().apply(block)

val m = menu {
    item("Settings") {
        icon = R.drawable.ic_settings
        onClick = { openSettings() }
        // item("Nested")   // compile error thanks to @DslMarker
    }
}
```

Without `@DslMarker`, inside `Item`'s block you could still call `item(...)` from the outer `Menu` receiver by accident. `@DslMarker` stops implicit access to outer receivers of the same DSL. You can still reach them explicitly with `this@menu`.

> **Note:** Kotlin 2.2 added context parameters as a preview feature. They are the successor to the old experimental context receivers. Treat them as preview and do not rely on them in production code yet.

## Under the Hood

Decompile any Kotlin file in Android Studio: Tools, Kotlin, Show Kotlin Bytecode, then Decompile. Do this often. It is the fastest way to answer "what does this cost?"

### Data class

```kotlin
data class Point(val x: Int, val y: Int)
```

```java
public final class Point {
    private final int x; private final int y;
    public Point(int x, int y) { this.x = x; this.y = y; }
    public final int getX() { return x; }
    public final int component1() { return x; }
    public final int component2() { return y; }
    public final Point copy(int x, int y) { return new Point(x, y); }
    // plus synthetic copy$default(Point, int, int, int mask, Object)
    public String toString() { return "Point(x=" + x + ", y=" + y + ")"; }
    public int hashCode() { return Integer.hashCode(x) * 31 + Integer.hashCode(y); }
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof Point)) return false;
        Point p = (Point) other;
        return x == p.x && y == p.y;
    }
}
```

The class is `final`. Getters are `final`. Only constructor properties appear.

### when on enums

A `when` over an enum compiles to a `tableswitch` on an index array. The compiler creates a synthetic class (like `MainKt$WhenMappings`) holding `$EnumSwitchMapping$0`, an `int[]` mapping each `ordinal()` to a case number. This protects against the enum being reordered in another compilation unit.

```java
switch (WhenMappings.$EnumSwitchMapping$0[priority.ordinal()]) {
    case 1: return "low";
    case 2: return "high";
    default: throw new NoWhenBranchMatchedException();
}
```

A `when` on dense `Int` constants compiles to `tableswitch`; sparse constants use `lookupswitch`. A `when` on strings uses `hashCode()` switching, like Java. Otherwise it is an `if`/`else` chain.

### String templates

`"Hi $name, you have ${count + 1} items"` becomes string concatenation. When targeting JVM 9 or newer, the compiler uses `invokedynamic` with `StringConcatFactory.makeConcatWithConstants`. For older targets it uses `StringBuilder.append` chains. Android's D8/R8 desugars `invokedynamic` concatenation for older devices.

### Companion objects

```kotlin
class Api { companion object { val URL = "x"; const val V = 2; fun create() = Api() } }
```

```java
public final class Api {
    public static final int V = 2;                       // const: static field in outer class
    private static final String URL = "x";               // backing field in outer class
    public static final Api.Companion Companion = new Api.Companion(null);
    public static final class Companion {
        public final String getURL() { return Api.URL; }
        public final Api create() { return new Api(); }
    }
}
```

From Java you must write `Api.Companion.create()` unless you add `@JvmStatic`.

### Inline functions

```kotlin
inline fun guard(cond: Boolean, block: () -> Unit) { if (cond) block() }
fun test(x: Int) { guard(x > 0) { println(x) } }
```

```java
public static final void test(int x) {
    boolean cond = x > 0;
    if (cond) { System.out.println(x); }   // no lambda object, no call
}
```

### Other things worth decompiling

- `object Foo` becomes a class with `public static final Foo INSTANCE` created in a static initializer.
- `lateinit var` adds a null check that throws `UninitializedPropertyAccessException` in the getter.
- Top-level properties become static fields in `FileKt` with static getters.
- `for (i in 0 until n)` and `for (i in 0..<n)` compile to a plain counting loop. No `IntRange` object.
- `repeat(n) { }` is inline and becomes a plain loop.

## Performance and Pitfalls

### Performance tips

- Use primitive types and arrays (`IntArray`) in hot code. Nullable `Int?` and generics box values.
- Use `inline` for small higher-order utilities called often. Do not inline large functions.
- Use sequences for long chains over large data or when you short-circuit. Use lists for small collections.
- Use `lazy` for expensive one-time setup. Use `LazyThreadSafetyMode.NONE` when only one thread touches it.
- Use `const val` for compile-time constants so they are inlined.
- Use value classes for type-safe wrappers without allocation. Be aware they box when nullable or generic.
- Prefer `buildList { }`, `buildString { }` and `ArrayList(capacity)` to avoid repeated copying.
- Avoid `!!` and repeated `?.` chains in loops; check once and smart-cast.
- Avoid capturing lambdas in hot paths that are not inline; each call may allocate.
- Use `entries` not `values()` on enums.
- Remember R8 removes unused code and can inline many small Kotlin-generated getters.

### Common pitfalls

- `val` does not mean immutable; the object may still change.
- Extension functions do not override; they dispatch on declared type.
- `copy()` is shallow.
- Data class `equals` ignores properties declared in the body.
- Arrays in data classes compare by reference.
- `runCatching` swallows `CancellationException`.
- `?.let { } ?: other` runs `other` when the lambda returns null.
- `lateinit` on a property read before set crashes; check `::x.isInitialized` when unsure.
- Calling `open` members from constructors sees uninitialized subclass state.
- `inner` classes and anonymous objects leak the outer Activity or Fragment.
- `Delegates.observable` triggers even when the new value equals the old one.
- `return` inside a non-inline lambda is not allowed without a label; inside an inline lambda it returns from the outer function, which surprises people.
- `List<T>` from Java can still be mutated underneath you.
- `==` on `Double.NaN`: with static `Double` types, `NaN == NaN` is false (IEEE). When typed as `Any` or `Double?` boxed, `equals` is used and it is true. Be careful with floating point equality.
- Platform types from Java can hide nulls until runtime.

### Recent language additions worth knowing

- Kotlin 2.0: K2 compiler stable, better smart casts, faster compilation.
- Kotlin 2.2 stabilized guard conditions in `when` (`is Error if it.code == 404 ->`), non-local `break` and `continue` inside inline lambdas, and multi-dollar string interpolation (`$$"price: $$amount"`) for text containing literal `$` signs.

```kotlin
when (state) {
    is UiState.Error if state.message.isBlank() -> showGeneric()
    is UiState.Error -> showError(state.message)
    else -> Unit
}
```

## Interview Questions

### Q: What is the difference between val, var and const val?

`var` can be reassigned. `val` is assigned once; the reference is final but the object may be mutable. `const val` is a compile-time constant of primitive or `String` type, declared at top level or in an `object`; its value is inlined at every use site.

### Q: How does Kotlin's null safety work, and where can NPE still happen?

Types are non-null by default and `T?` marks nullable types; the compiler forces you to handle null before use. NPEs can still happen with `!!`, platform types from unannotated Java, `lateinit` (as `UninitializedPropertyAccessException`), calling open members from constructors, and data shared with Java code that writes null.

### Q: lateinit vs lazy?

`lateinit` is for a `var` of non-null, non-primitive type that you set later from outside, like injection or `onCreate`. `lazy` is for a `val` computed once by a lambda on first access, synchronized by default. `lateinit` has no thread safety; `lazy` supports primitives and nullables.

### Q: How are extension functions implemented, and can they be overridden?

They compile to static methods with the receiver as the first parameter, in a `FileNameKt` class. They are resolved statically by the declared type, so they cannot be overridden or behave polymorphically, and a member with the same signature always wins.

### Q: What does inline do, and when do you need noinline or crossinline?

`inline` copies the function and its lambda arguments into the call site, removing lambda allocation and call overhead and allowing non-local returns and `reified` types. `noinline` keeps a lambda as an object so you can store or pass it on. `crossinline` keeps inlining but forbids non-local returns, needed when the lambda runs in another execution context like a nested lambda or `Runnable`.

### Q: What is a reified type parameter?

A type parameter of an inline function marked `reified`, whose real class is available at runtime. You can use `T::class`, `is T` and `as T`. It works because the body is inlined at each call site where the concrete type is known, which bypasses type erasure.

### Q: Explain the scope functions in one sentence each.

`let` passes the object as `it` and returns the lambda result, great with `?.`. `run` uses `this` and returns the result. `with` is the non-extension version of `run`. `apply` uses `this` and returns the object, for configuration. `also` uses `it` and returns the object, for side effects.

### Q: Sealed class vs enum vs sealed interface?

An enum has a fixed set of single instances with the same structure. A sealed class has a fixed set of subclasses that can carry different data and have many instances, sharing a base constructor. A sealed interface is the same but allows multiple inheritance and can be implemented by enums and objects. All enable exhaustive `when`.

### Q: What does a data class generate, and what are its limits?

`equals`, `hashCode`, `toString`, `copy` and `componentN`, using only primary constructor properties. It cannot be `open`, `abstract`, `sealed` or `inner`. `copy` is shallow, and array properties compare by reference.

### Q: Explain in and out variance.

`out T` means the type only produces `T`, making it covariant: `List<Cat>` is a `List<Animal>`. `in T` means it only consumes `T`, making it contravariant: `Comparator<Animal>` works as a `Comparator<Cat>`. Kotlin supports this at declaration site on the class and at use site with type projections like `Array<out T>`.

### Q: Sequence vs List operations?

List operations are eager and create a new collection at every step. Sequence operations are lazy and process each element through the whole chain only when a terminal operation runs, with no intermediate collections and early exit. Sequences win for large data, long chains or short-circuiting; lists win for small data due to lower overhead.

### Q: == vs === in Kotlin?

`==` is structural equality: a null-safe call to `equals`. `===` is referential equality: same object in memory. Never use `===` on boxed numbers.

### Q: What is a value class and when does it box?

A `@JvmInline value class` wraps one value and is represented by that underlying value at runtime, giving type safety without allocation. It boxes when used as a nullable type, as a generic type argument, or through an interface type. Functions taking it get mangled JVM names.

### Q: How does a companion object differ from Java static?

A companion is a real singleton object nested in the class, accessed through a static `Companion` field. Its members are instance methods of that object unless you add `@JvmStatic`, `@JvmField` or `const`. Because it is an object, it can implement interfaces and have extension functions.

### Q: How does class delegation with by work?

`class A(b: B) : B by b` makes the compiler generate all methods of interface `B` that forward to `b`, except ones you override. It is composition without boilerplate. The delegate does not call your overrides, so it is not the same as inheritance.

### Q: Why does Kotlin not have checked exceptions?

The designers found that checked exceptions in large codebases led to empty catch blocks and noisy signatures without improving reliability. Kotlin lets you handle errors where it makes sense, and uses `@Throws` for Java callers. For expected failures, use `Result` or a sealed result type.

### Q: What does internal mean, and how is it compiled?

`internal` means visible inside the same module (a Gradle module or source set). The JVM has no such concept, so internal members compile to public with mangled names for functions. Java code can technically still call them.

## Cheat Sheet and Practice

### Quick reference

| Topic | Remember |
|---|---|
| Null safety | `?.` `?:` `!!` `as?` ; `?:` right side can be `return`/`throw` |
| Special types | `Any` root, `Unit` singleton, `Nothing` never returns, `null` is `Nothing?` |
| Platform type | `T!` from unannotated Java; declare type explicitly |
| lateinit | `var`, non-null, non-primitive, `::x.isInitialized` |
| lazy | `val`, synchronized default, modes PUBLICATION and NONE |
| Extensions | Static methods, receiver is first param, static dispatch, member wins |
| inline | Copies body; enables non-local return and `reified` |
| noinline | Keep lambda as object to store it |
| crossinline | Inline but no non-local return |
| Scope fns | `let`/`also` use `it`; `run`/`with`/`apply` use `this`; `apply`/`also` return object |
| data class | equals/hashCode/toString/copy/componentN from primary ctor only |
| sealed | Closed hierarchy, same module and package, exhaustive `when` |
| value class | One property, no allocation, boxes when nullable or generic |
| object | Thread-safe lazy singleton via static `INSTANCE` |
| Variance | `out` producer covariant, `in` consumer contravariant, `*` unknown |
| Erasure | No `is List<String>`; use `reified` or pass `KClass` |
| Collections | Read-only is not immutable; ops on lists are eager |
| Sequences | Lazy, per element, need terminal op |
| Equality | `==` equals (null-safe), `===` same reference |
| Exceptions | No checked; `runCatching` catches CancellationException too |
| Visibility | `internal` = module; compiles to public, mangled |
| Interop | `@JvmStatic` `@JvmField` `@JvmOverloads` `@JvmName` `@Throws` |
| SAM | Java SAM works with lambdas; Kotlin needs `fun interface` |
| DSL | Lambda with receiver `T.() -> Unit` plus `@DslMarker` |
| Decompile | Tools, Kotlin, Show Kotlin Bytecode, Decompile |

### Practice exercises

1. **Lazy from scratch.** Implement `fun <T> myLazy(init: () -> T): ReadOnlyProperty<Any?, T>` that is thread-safe with double-checked locking and supports `null` values. Use it as `val x by myLazy { ... }`. Then write a test that starts 10 threads reading `x` and checks the initializer ran exactly once.
2. **SharedPreferences delegates.** Write `ReadWriteProperty` delegates `boolean(key, default)`, `int(key, default)` and `string(key, default)` as extension functions on `SharedPreferences`. Use them in a `Settings` class. Bonus: use `property.name` as the default key.
3. **Sealed result pipeline.** Model `sealed interface LoadResult<out T>` with `Loading`, `Success<T>`, and `Failure(error: AppError)` where `AppError` is itself sealed. Write `map`, `onSuccess` and `getOrNull` extension functions. Explain why `out` lets `LoadResult<Nothing>` be used as `LoadResult<User>`.
4. **Sequence vs list benchmark.** Take a list of 1,000,000 numbers, run `map`, `filter`, `first` both as a list and as a sequence, and count how many times each lambda runs using counters. Then repeat with a 10-element list and compare timings. Write down when each wins.
5. **Type-safe DSL.** Build an `http { get("/users") { header("Auth", token); query("page", 1) } }` DSL that produces a `Request` data class. Use `@DslMarker` so `get` cannot be called inside `get`. Decompile it and point out where the lambdas were inlined (make the builder function `inline`) and where they were not.

### References

- [Kotlin language documentation](https://kotlinlang.org/docs/home.html)
- [Null safety](https://kotlinlang.org/docs/null-safety.html)
- [Properties and backing fields](https://kotlinlang.org/docs/properties.html)
- [Extensions](https://kotlinlang.org/docs/extensions.html)
- [Inline functions](https://kotlinlang.org/docs/inline-functions.html)
- [Scope functions](https://kotlinlang.org/docs/scope-functions.html)
- [Data classes](https://kotlinlang.org/docs/data-classes.html)
- [Sealed classes and interfaces](https://kotlinlang.org/docs/sealed-classes.html)
- [Inline value classes](https://kotlinlang.org/docs/inline-classes.html)
- [Delegation](https://kotlinlang.org/docs/delegation.html) and [delegated properties](https://kotlinlang.org/docs/delegated-properties.html)
- [Generics: in, out, where](https://kotlinlang.org/docs/generics.html)
- [Sequences](https://kotlinlang.org/docs/sequences.html)
- [Equality](https://kotlinlang.org/docs/equality.html)
- [Exceptions](https://kotlinlang.org/docs/exceptions.html)
- [Visibility modifiers](https://kotlinlang.org/docs/visibility-modifiers.html)
- [Calling Kotlin from Java](https://kotlinlang.org/docs/java-to-kotlin-interop.html)
- [Functional (SAM) interfaces](https://kotlinlang.org/docs/fun-interfaces.html)
- [Type-safe builders](https://kotlinlang.org/docs/type-safe-builders.html)
- [K2 compiler migration guide](https://kotlinlang.org/docs/k2-compiler-migration-guide.html)
- [What's new in Kotlin](https://kotlinlang.org/docs/whatsnew22.html)
- [Kotlin style guide for Android](https://developer.android.com/kotlin/style-guide)
