## Type system basics

How Kotlin's types work, what the compiler infers for you, and the three special types interviewers love.

:::tldr
- Every value acts like an object, but a non-null `Int` still compiles to a fast JVM `int`.
- `Any` is the root type, `Unit` means "no useful value", `Nothing` means "never returns".
- The compiler infers local types; write types out on public APIs.
:::

### Everything is an object

In Kotlin you can call members on any value, even numbers. `5.toString()` and `3.coerceAtLeast(1)` are both valid. The language has no separate primitive types like Java's `int`.

The compiler still keeps this fast. A non-null `Int` becomes a JVM `int`. It is boxed into `java.lang.Integer` only when it has to be an object.

```kotlin
val a: Int = 5                     // JVM: int
val b: Int? = 5                    // JVM: Integer (null needs an object)
val list: List<Int> = listOf(1, 2) // Integer inside: generics need objects
val any: Any = 5                   // Integer: stored as an object
```

The same is true for `Long`, `Double`, `Boolean`, `Char` and the other basic types.

> **Tip:** In hot code, prefer `Int` over `Int?` and `IntArray` over `List<Int>`. Boxing allocates an object.

### No silent number conversions

Java quietly widens an `int` to a `long`. Kotlin does not. You convert with an explicit call like `toLong()`.

```kotlin
val i: Int = 10
// val l: Long = i          // compile error
val l: Long = i.toLong()    // explicit conversion
val sum = i + l             // ok: Int.plus(Long) returns Long
val x = 1L; val f = 1.5f; val big = 1_000_000
```

Arithmetic operators have overloads for mixed types, so `i + l` works. Plain assignment never converts.

### Type inference

The compiler works out a type from the value on the right. You still get full static typing. You just type less.

```kotlin
val name = "Ana"                     // String
val ratio = 7 / 2                    // Int, value 3 (integer division)
val big = 3_000_000_000              // Long: too big for Int
val items = mutableListOf<String>()  // empty list: type argument needed
fun square(x: Int) = x * x           // return type Int is inferred
fun area(r: Double): Double {        // block body: declare the type
    return Math.PI * r * r
}
```

The rules are simple:

- A function with an expression body (`= ...`) can infer its return type.
- A function with a block body (`{ ... }`) must declare its return type, unless it returns `Unit`.
- Public functions and properties should declare their types anyway. It keeps the API stable when the body changes.

> **Tip:** Library modules can turn on explicit API mode with `kotlin { explicitApi() }` in Gradle. The compiler then forces visibility and types on every public declaration.

### Any, Unit and Nothing

| Type | Meaning | Java equivalent |
|---|---|---|
| `Any` | Root of all non-null types | `Object` |
| `Any?` | Root of every type | `Object` (nullable) |
| `Unit` | "No useful value". A real singleton object | `void` |
| `Nothing` | "This never returns". Has no instances | none |
| `Nothing?` | The type of the `null` literal | none |

`Any` has only three members: `equals`, `hashCode` and `toString`.

`Unit` is a real object. That is why `() -> Unit` is a normal function type you can store and pass around. In bytecode, a function returning `Unit` still compiles to a `void` method where it can.

`Nothing` is a subtype of every type. A function that always throws returns `Nothing`. The `throw` expression itself also has type `Nothing`. This lets the compiler know the code after it is unreachable.

```kotlin
fun fail(msg: String): Nothing = throw IllegalStateException(msg)

val user = findUser() ?: fail("no user")  // user is non-null after this
val x: Int = TODO()                       // TODO() returns Nothing
val n = null                              // type is Nothing?
```

> **Interview:** "Why is `Nothing` a subtype of every type?" So that `throw`, `return` and `TODO()` can sit anywhere a value is expected, like the right side of `?:`, and the whole expression keeps the useful type.

### Type checks and casts

- `x is String` checks the type. `!is` is the negation.
- `x as String` casts. It throws `ClassCastException` if wrong.
- `x as? String` is a safe cast. It returns `null` if wrong.

After an `is` check the compiler smart-casts the value, so you rarely need `as`. Lesson 4 covers smart casts.

:::deeper Number types at a glance
| Type | Size | Literal |
|---|---|---|
| `Byte` | 8 bits | `val b: Byte = 1` |
| `Short` | 16 bits | `val s: Short = 1` |
| `Int` | 32 bits | `1` |
| `Long` | 64 bits | `1L` |
| `Float` | 32 bits | `1.5f` |
| `Double` | 64 bits | `1.5` |

- `Char` is not a number in Kotlin. Use `'a'.code` to get its integer value.
- Unsigned types exist too: `UByte`, `UShort`, `UInt`, `ULong`, with literals like `42u`.
- Underscores make long literals readable: `1_000_000`.
- Division of two integers is integer division. Make one side a `Double` to get a fraction: `7 / 2.0` is `3.5`.
:::

:::check
Q: What is the type and value of `val r = 7 / 2`?
A: `Int` with value `3`. Integer division drops the fraction; write `7 / 2.0` to get `3.5`.
Q: Why does `val name: String = user?.name ?: throw IllegalStateException()` compile?
A: `throw` is an expression of type `Nothing`, which is a subtype of `String`. So the whole Elvis expression is still a `String`.
Q: Interview: Kotlin has no primitive types in the language. Does that make `Int` slow?
A: No. A non-null `Int` compiles to a JVM `int`. It is boxed only when it is nullable, used as a generic type argument, or stored as `Any`.
:::

## val, var and properties

How Kotlin properties really work: fields, accessors, constants, and the two ways to initialize late.

:::tldr
- `val` fixes the reference, not the object; `const val` is a compile-time constant that gets inlined.
- A property is a getter (plus setter) with an optional backing field you reach through `field`.
- Use `lateinit` for values set from outside later; use `lazy` for values computed once on first read.
:::

### val vs var

- `val` is read-only. You cannot reassign it. It is like a Java `final` variable.
- `var` can be reassigned.
- `val` does not mean immutable. Only the reference is fixed.

```kotlin
val list = mutableListOf(1)
list.add(2)          // fine: the object changes
// list = mutableListOf()  // error: the reference is fixed
```

### const val

`const val` is a compile-time constant. It must be a primitive or a `String`. It must live at top level, in an `object`, or in a companion object.

```kotlin
const val MAX_RETRIES = 3          // top level
object Keys { const val TOKEN = "token" }
```

The compiler copies the value into every place that uses it. There is no getter call at runtime.

> **Pitfall:** Because the value is copied into callers, changing a `const` in a library does not update already-compiled callers until they are rebuilt.

### Properties and backing fields

A Kotlin property is a getter, a setter (for `var`), and maybe a field. You never declare the field yourself. Inside an accessor, the keyword `field` refers to it.

```kotlin
class User {
    var name: String = ""
        set(value) {
            field = value.trim()   // write the backing field
        }

    val isValid: Boolean
        get() = name.isNotEmpty()  // computed: no backing field

    var counter = 0
        private set                // public getter, private setter
}
```

The compiler creates a backing field only if an accessor uses the default implementation or mentions `field`. `isValid` above has no field. It is computed on every read.

> **Pitfall:** Writing `name = value` inside the setter of `name` calls the setter again. That is infinite recursion and a `StackOverflowError`. Use `field = value`.

### The backing property pattern

A common Android pattern is a private mutable property with a public read-only view.

```kotlin
private val _state = MutableStateFlow(UiState())
val state: StateFlow<UiState> = _state.asStateFlow()
```

Outside code can read `state` but cannot push new values. Only the class can change `_state`.

### lateinit vs lazy

Sometimes you cannot give a property its value in the constructor. Kotlin gives you two tools.

| | `lateinit var` | `val by lazy` |
|---|---|---|
| Keyword | `var` only | `val` only |
| Types | Non-null, non-primitive | Any type, even nullable or primitive |
| Who sets it | You, later, from outside | The lambda, on first read |
| Thread safety | None | Synchronized by default |
| Check if set | `::prop.isInitialized` | `isInitialized()` on the `Lazy` object |
| Read too early | `UninitializedPropertyAccessException` | Never too early: it computes now |

Use `lateinit` for values injected or set in a lifecycle callback. Think Hilt fields or views bound in `onCreate`. Use `lazy` for expensive values you want to compute once, on first use.

```kotlin
class ProfileActivity : AppCompatActivity() {
    @Inject lateinit var analytics: Analytics
    private val adapter by lazy { ProfileAdapter(::onItemClick) }

    fun log() {
        if (::analytics.isInitialized) analytics.track("open")
    }
}
```

> **Under the hood:** A `lateinit` property is a plain nullable field. The getter checks it for null and throws `UninitializedPropertyAccessException` with the property name.

### How lazy works

`lazy { }` returns a `Lazy<T>` object. The property getter calls its `value`. There are three thread-safety modes:

- `SYNCHRONIZED` (default): double-checked locking. Only one thread runs the initializer.
- `PUBLICATION`: several threads may run the initializer, but the first published result wins.
- `NONE`: no locking. Fastest. Safe only when one thread uses it, such as the Android main thread.

If the initializer throws, the value stays uninitialized. The next read tries again.

> **Tip:** For main-thread-only UI values, `lazy(LazyThreadSafetyMode.NONE) { }` skips the lock. The saving is small, so use it in hot paths, not everywhere.

:::deeper A simplified synchronized lazy
```kotlin
private object UNINITIALIZED

class SimpleSyncLazy<T>(initializer: () -> T) : Lazy<T> {
    private var init: (() -> T)? = initializer
    @Volatile private var _value: Any? = UNINITIALIZED

    @Suppress("UNCHECKED_CAST")
    override val value: T
        get() {
            val v1 = _value
            if (v1 !== UNINITIALIZED) return v1 as T   // fast path, no lock
            return synchronized(this) {
                val v2 = _value
                if (v2 !== UNINITIALIZED) v2 as T
                else init!!().also { _value = it; init = null }
            }
        }
    override fun isInitialized() = _value !== UNINITIALIZED
}
```

- The `UNINITIALIZED` sentinel lets `lazy` store `null` as a real value.
- `@Volatile` makes the written value visible to other threads.
- Setting `init = null` frees the lambda and everything it captured.
:::

:::check
Q: Spot the bug: `var name = "" set(value) { name = value.trim() }`.
A: The setter assigns `name`, which calls the same setter again forever. Use `field = value.trim()`.
Q: You read a `val config by lazy { load() }` and `load()` throws. What happens on the next read?
A: `load()` runs again. A failed initializer leaves the value uninitialized, so the next access retries.
Q: Interview: lateinit vs lazy, when would you pick each?
A: `lateinit var` for a non-null value that something outside sets later, like DI or `onCreate`. `lazy` for a `val` that the class can compute itself, once, on first use, with thread safety built in.
:::

## Functions

The function features that replace Java boilerplate, and what each one compiles to.

:::tldr
- Default and named arguments replace most overloads; Java needs `@JvmOverloads` to see them.
- Extension functions compile to static methods, so they dispatch on the declared type and never override.
- `infix`, `operator`, `tailrec` and `vararg` are small features that come up often in interviews.
:::

### Default and named arguments

```kotlin
fun connect(host: String, port: Int = 443, secure: Boolean = true) { }

connect("api.example.com")
connect("api.example.com", secure = false)   // skip port by naming
```

Default arguments replace most Java overloads. Named arguments make calls with many booleans readable.

> **Under the hood:** The compiler adds a synthetic method `connect$default(host, port, secure, mask, marker)`. The `mask` is a bit field that says which arguments were left out. Java cannot see the defaults unless you add `@JvmOverloads`.

### Single-expression and local functions

A function whose body is one expression can use `=`. The return type is inferred.

```kotlin
fun square(x: Int) = x * x

fun validate(user: User) {
    fun check(value: String, field: String) {      // local function
        require(value.isNotEmpty()) { "$field empty for ${user.id}" }
    }
    check(user.name, "name")
    check(user.email, "email")
}
```

A local function can read the outer function's variables, like `user` above. It keeps a helper private to the one place that needs it.

### Extension functions

Extensions add functions to a type without changing its source or subclassing it.

```kotlin
fun String.isEmail(): Boolean = contains("@") && contains(".")
val String.lastChar: Char get() = this[length - 1]   // extension property
fun String?.orDash(): String = this ?: "-"            // nullable receiver

"a@b.com".isEmail()
```

An extension compiles to a static method. The receiver becomes the first parameter. If the file is `StringUtils.kt`, Java sees this:

```java
public final class StringUtilsKt {
    public static final boolean isEmail(@NotNull String $this$isEmail) { ... }
}
```

Because it is static:

- It is resolved by the declared type of the variable, not the runtime type.
- If the class has a member with the same signature, the member always wins.
- It cannot see `private` or `protected` members of the receiver.
- An extension property cannot have a backing field. It needs a getter.

```kotlin
open class Shape
class Circle : Shape()
fun Shape.name() = "Shape"
fun Circle.name() = "Circle"

val s: Shape = Circle()
println(s.name())   // "Shape": chosen by the declared type
```

> **Interview:** "Can extension functions be overridden?" No. They are static methods. The compile-time type of the receiver picks which one runs.

### Infix functions

A member or extension with exactly one parameter can be marked `infix`. You then call it without the dot and parentheses.

```kotlin
infix fun Int.pow(exp: Int): Int = (1..exp).fold(1) { acc, _ -> acc * this }
val x = 2 pow 10          // 1024
val pair = "key" to 42    // the stdlib's `to` is infix
```

### Operator overloading

You overload a fixed set of operators by writing a function with a set name and the `operator` modifier.

```kotlin
data class Vec(val x: Int, val y: Int) {
    operator fun plus(o: Vec) = Vec(x + o.x, y + o.y)
    operator fun times(k: Int) = Vec(x * k, y * k)
}
val v = Vec(1, 2) + Vec(3, 4) * 2   // Vec(7, 10)
```

> **Pitfall:** `==` maps to `equals`, which you override normally, without `operator`. `===` cannot be overloaded.

### tailrec

`tailrec` tells the compiler to turn tail recursion into a loop. No stack frames pile up.

```kotlin
tailrec fun gcd(a: Int, b: Int): Int = if (b == 0) a else gcd(b, a % b)
```

The recursive call must be the very last thing the function does. It cannot sit inside `try`/`catch`/`finally`, and the function cannot be `open`. If the call is not in tail position, the compiler warns and does not optimize.

### varargs

```kotlin
fun log(vararg tags: String) = tags.joinToString()
val arr = arrayOf("a", "b")
log("x", *arr)   // the spread operator copies the array in
```

Inside the function, `tags` is an `Array<out String>`. A `vararg n: Int` becomes a primitive `IntArray`.

:::deeper The operator table
| Expression | Function called |
|---|---|
| `a + b` | `a.plus(b)` |
| `a += b` | `a.plusAssign(b)` or `a = a.plus(b)` |
| `a[i]` and `a[i] = v` | `get(i)` and `set(i, v)` |
| `a(x)` | `a.invoke(x)` |
| `x in a` | `a.contains(x)` |
| `a < b` | `a.compareTo(b) < 0` |
| `a..b` and `a..<b` | `rangeTo` and `rangeUntil` |
| `val (x, y) = a` | `component1()`, `component2()` |
| `for (x in a)` | `iterator()` |
| `-a`, `!a`, `a++` | `unaryMinus`, `not`, `inc` |

- If both `plus` and `plusAssign` exist and `a` is a `var`, `a += b` is ambiguous and does not compile.
- Read-only lists have `plus`, so `list += x` on a `var list: List<T>` builds a new list each time.
:::

:::check
Q: `val s: Shape = Circle()` with `fun Shape.name() = "Shape"` and `fun Circle.name() = "Circle"`. What does `s.name()` return?
A: `"Shape"`. Extensions are static, so the declared type `Shape` picks the function, not the runtime type.
Q: A class has a member `fun size(): Int` and you add `fun MyList.size(): Int = 0`. Which runs on `myList.size()`?
A: The member. A member always wins over an extension with the same signature, and the compiler warns the extension is shadowed.
Q: Interview: How does Java call a Kotlin function that has default arguments?
A: It must pass every argument, because Java only sees the full signature. Add `@JvmOverloads` to generate the shorter overloads.
:::

## Null safety

How Kotlin turns most null crashes into compile errors, and the few places where they still slip through.

:::tldr
- `String` can never be null; `String?` can, and the compiler makes you handle it.
- Use `?.`, `?:`, `?.let` and smart casts; treat every `!!` as a possible crash.
- Values from unannotated Java are platform types (`String!`), so declare their type at the boundary.
:::

### Nullable and non-null types

Every type has two forms. `String` can never hold `null`. `String?` can. The compiler checks this, so most `NullPointerException`s become compile errors.

```kotlin
var name: String = "Ana"
// name = null                 // compile error
var nick: String? = null
// nick.length                 // compile error: nick may be null
```

### The null-safety operators

```kotlin
val len1 = nick?.length             // safe call: Int?
val len2 = nick?.length ?: 0        // Elvis: fallback when null
val len3 = nick!!.length            // assertion: throws NPE if null
val num = input as? Int             // safe cast: null if not an Int
val city = user?.address?.city      // chain: null if any step is null
```

- `?.` returns `null` instead of calling the member when the receiver is null.
- `?:` gives a fallback. Its right side can be `return` or `throw`, because both are expressions of type `Nothing`.
- `!!` says "I know better than the compiler". Use it rarely. Each `!!` is a possible crash.
- `as?` returns `null` instead of throwing `ClassCastException`.

```kotlin
fun show(id: String?) {
    val safeId = id ?: return          // early exit
    val user = repo.find(safeId) ?: throw NotFound(safeId)
    render(user)                       // both are non-null here
}
```

### let for null checks

`?.let { }` runs a block only when the value is non-null. Inside, `it` is the non-null value.

```kotlin
nick?.let { println(it.uppercase()) }
val length = nick?.let { it.trim().length } ?: 0
```

The stdlib also has helpers for common cases: `orEmpty()`, `isNullOrEmpty()`, `isNullOrBlank()` and `filterNotNull()`.

### Smart casts

After a null check or type check, the compiler treats the variable as the narrower type. No cast needed.

```kotlin
fun greet(name: String?) {
    if (name == null) return
    println(name.length)  // smart cast to String
}

fun describe(x: Any): String = when (x) {
    is String -> "String of length ${x.length}"
    is Int -> "Int doubled ${x * 2}"
    else -> "Unknown"
}
```

Smart casts only work when the compiler can prove the value cannot change between the check and the use. They work on:

- `val` locals.
- `val` properties without a custom getter, declared in the same module.
- `var` locals that no lambda modifies.

They do not work on `var` class properties, `open` properties, or properties with custom getters. Another thread or a subclass could change them.

> **Pitfall:** `if (this.name != null) name.length` fails when `name` is a `var` property. Copy it to a local `val` first, or use `name?.let { }`.

### Platform types

When you call Java code without nullability annotations, Kotlin cannot know if a value may be null. It gives you a platform type, shown in the IDE as `String!`. You may treat it as `String` or as `String?`.

```kotlin
val s = javaObj.getName()              // String! : unknown nullability
val safe: String? = javaObj.getName()  // best: decide at the boundary
```

If you treat it as `String` and it is actually null, you get an NPE right there.

> **Tip:** At the Java boundary, always write the type explicitly. That turns an unknown platform type into a known Kotlin type in one place.

> **Note:** Java code annotated with `@Nullable` or `@NonNull` (AndroidX, JetBrains, JSpecify and others) is read as real Kotlin types, not platform types.

### Where NPEs can still happen

- Using `!!` on a null value.
- Platform types from unannotated Java.
- Reading a `lateinit` property before it is set (this throws `UninitializedPropertyAccessException`).
- Calling an `open` member from a base class constructor, before the subclass has set its fields.
- Java code writing `null` into your Kotlin objects.

:::deeper Smart casts in K2 and under the hood
The K2 compiler (Kotlin 2.0) made smart casts smarter.

- It remembers checks stored in local `val`s.
- It merges `is` checks joined by `||` into their common supertype.
- It handles more cases inside lambdas and loops.

```kotlin
fun process(a: Any) {
    val isText = a is String
    if (isText) println(a.length)  // K2: smart cast works through the local
}
```

> **Under the hood:** Nullability exists only at compile time. At runtime, `String` and `String?` are the same `java.lang.String`. The compiler adds `@NotNull`/`@Nullable` annotations and inserts checks like `Intrinsics.checkNotNullParameter` on public parameters, so a Java caller passing null fails fast with a clear message.
:::

:::check
Q: What does `a?.length ?: -1` return when `a` is null, and when `a` is `"hi"`?
A: `-1` when null, because the safe call gives null and Elvis uses the fallback. `2` when `a` is `"hi"`.
Q: Why does `if (user.name != null) print(user.name.length)` fail to compile when `name` is a `var` property?
A: The compiler cannot prove `name` stays non-null between the check and the use, since another thread could change it. Copy it to a local `val` or use `user.name?.let { }`.
Q: Interview: Kotlin has null safety, so where can a `NullPointerException` still happen?
A: With `!!`, with platform types from unannotated Java, when an `open` member is called from a base constructor, and when Java writes null into Kotlin objects. A `lateinit` read too early also crashes, with its own exception.
:::

## Lambdas and inline

How Kotlin treats functions as values, what a lambda costs, and how `inline` removes that cost.

:::tldr
- A higher-order function takes or returns a function; a trailing lambda can go outside the parentheses.
- `inline` copies the function and its lambdas into the call site: no allocation, plus non-local `return` and `reified`.
- `noinline` keeps a lambda as an object; `crossinline` inlines it but forbids non-local `return`.
:::

### Function types and lambdas

Functions are first-class values. A function type looks like `(Int, Int) -> Int`. A lambda is a function literal of that type.

```kotlin
val sum: (Int, Int) -> Int = { a, b -> a + b }
val isEven: (Int) -> Boolean = { it % 2 == 0 }  // `it` for one parameter
val ref = ::println                             // function reference
val maybe: ((String) -> Unit)? = null           // nullable function type

fun applyOp(x: Int, op: (Int) -> Int) = op(x)   // higher-order function
applyOp(5) { it * 3 }                           // trailing lambda: 15
```

Some lambda rules worth knowing:

- The last expression in a lambda is its result. You do not write `return`.
- If a function's last parameter is a function, you can pass the lambda outside the parentheses.
- If the lambda is the only argument, you can drop the parentheses: `list.forEach { }`.
- Use `_` for parameters you do not use: `{ _, value -> value }`.

### Closures

A lambda can read and change variables from the scope around it. Unlike Java, it can modify a captured `var`.

```kotlin
var clicks = 0
button.setOnClickListener { clicks++ }   // allowed in Kotlin
```

> **Under the hood:** A captured `var` is wrapped in a small holder like `Ref.IntRef`, so the lambda and the function share it. That holder is one more object allocation.

### Why inline exists

A normal lambda is an object. If it captures variables, each call creates a new one. Calling it is a virtual `invoke` call. In a tight loop, that adds up.

`inline` tells the compiler to copy the function body and the lambda body into the call site.

```kotlin
inline fun <T> measure(block: () -> T): T {
    val start = System.nanoTime()
    return block().also { println("took ${System.nanoTime() - start}") }
}
```

After inlining, the call site holds the timing code and the block code directly. There is no lambda object and no `invoke` call. Most stdlib collection helpers like `map`, `filter` and `forEach` are inline for this reason.

### Non-local return

Inside an inline lambda, a plain `return` returns from the outer function. This is a non-local return.

```kotlin
fun findAdmin(users: List<User>): User? {
    users.forEach { if (it.isAdmin) return it }  // returns from findAdmin
    return null
}

users.forEach { if (it.isAdmin) return@forEach } // label: like `continue`
```

A plain `return` is not allowed in a non-inline lambda. Use a label like `return@forEach` to leave only the lambda.

### noinline and crossinline

- `noinline`: do not inline this lambda. You need it when you store the lambda or pass it to a non-inline function.
- `crossinline`: inline the lambda but forbid non-local `return`. You need it when the lambda runs inside another context, like a nested lambda or an object.

```kotlin
inline fun runBoth(a: () -> Unit, noinline b: () -> Unit) {
    a()
    callbacks.add(b)            // b must be a real object to be stored
}

inline fun postToMain(crossinline action: () -> Unit) {
    handler.post { action() }   // runs later, so `return` there makes no sense
}
```

> **Tip:** Inline only small functions that take lambdas. Inlining big functions bloats bytecode. The compiler warns when `inline` gives no benefit.

### Reified type parameters

Generic types are erased at runtime, so normally you cannot write `x is T`. In an inline function you can mark a type parameter `reified`. The body is copied to each call site, where the real type is known.

```kotlin
inline fun <reified T> Any.isA(): Boolean = this is T

inline fun <reified T : Activity> Context.start() =
    startActivity(Intent(this, T::class.java))

context.start<SettingsActivity>()
```

With `reified` you can use `T::class`, `is T` and `as T`.

> **Interview:** "Why does `reified` need `inline`?" A normal function has one compiled body for every `T`, so the type is gone. Inlining copies the body to each call site, and the compiler writes in the concrete class there.

:::deeper How lambdas compile
- Since Kotlin 2.0, non-inline lambdas on the JVM compile through `invokedynamic` by default, like Java lambdas. The class is created at runtime.
- A lambda that captures nothing can be reused as a single shared instance.
- A lambda that captures values allocates a new object each time the code runs.
- A captured `var` adds a `Ref` holder object.

> **Pitfall:** A public inline function cannot use private members of its class. Its body is copied into callers in other modules, which cannot see them. Mark the member `@PublishedApi internal` if you must.

An anonymous function is another way to write a function literal. A `return` inside it always returns from itself, never from the outer function.

```kotlin
users.forEach(fun(u) { if (u.isAdmin) return })  // like `continue`
```
:::

:::check
Q: Predict the result of `fun f(): String { listOf(1, 2, 3).forEach { if (it == 2) return "found" }; return "none" }`.
A: `"found"`. `forEach` is inline, so the `return` exits `f` itself.
Q: Inside an inline function you write `handler.post { action() }`, where `action` is a normal lambda parameter. Why does it not compile, and what fixes it?
A: `action` would be inlined into another lambda that runs later, where a non-local `return` could not work. Mark it `crossinline` (or `noinline`).
Q: Interview: What does `inline` buy you, and when should you not use it?
A: It removes lambda allocation and the `invoke` call, and enables non-local `return` and `reified`. Skip it for large functions or functions without lambda parameters, because it only bloats the bytecode.
:::

## Scope functions

The five small helpers you use every day, and a simple way to pick the right one.

:::tldr
- `let`, `run`, `with`, `apply` and `also` differ in two ways: `this` or `it`, and what they return.
- `apply` and `also` return the object; `let`, `run` and `with` return the lambda result.
- Do not nest them deeply, and watch out for `?.let { } ?: other`.
:::

### The table

All five run a block of code on an object. They differ in how you refer to the object and in what they return.

| Function | Object ref | Returns | Typical use |
|---|---|---|---|
| `let` | `it` | Lambda result | Null checks with `?.let`, transforming a value |
| `run` | `this` | Lambda result | Configure and compute a result |
| `with` | `this` | Lambda result | Many calls on one object (not an extension) |
| `apply` | `this` | The object | Builder-style configuration |
| `also` | `it` | The object | Side effects like logging or validation |

### One example each

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

- `let` turns a value into something else, and with `?.` it only runs on non-null.
- `apply` sets up an object and hands the same object back. Perfect for builders, `Intent`s and `Paint`s.
- `also` does something extra with the object, like logging, without changing the chain.
- `with` is a plain function, not an extension. You pass the object as an argument.
- `run` is like `with` but called as an extension, so it works with `?.run { }`.

### this or it?

With `this`, you call members without a prefix. That reads well when you mostly call the object's own members, as in `apply`.

With `it`, the object has a name. That reads better when you pass the object to other functions, as in `also { log(it) }`. You can also rename it: `user?.let { u -> show(u) }`.

### A quick decision guide

1. Do you need the object back? Use `apply` to configure it, or `also` for a side effect.
2. Do you need a computed result? Use `let` (with `it`), `run` (with `this`), or `with` (non-extension).
3. Is the value nullable? Use `?.let` or `?.run`.
4. Do you just want to run a block to get a value? Plain `run { }` with no receiver works too.

There are two cousins worth knowing:

- `takeIf { cond }` returns the object if the condition is true, else `null`.
- `takeUnless { cond }` does the opposite.

```kotlin
val port = input.toIntOrNull()?.takeIf { it in 1..65535 } ?: 8080
```

### Pitfalls

> **Pitfall:** `x?.let { a(it) } ?: b()` also runs `b()` when `a()` returns `null`, not only when `x` is null. Use `if`/`else` when the lambda can return null.

> **Pitfall:** Nested scope functions make `it` and `this` confusing. If you must nest, name the parameters or use plain local variables.

> **Pitfall:** `apply` returns the receiver, so a value you compute inside is thrown away. `"abc".apply { uppercase() }` is still `"abc"`.

A good rule: if a reader has to stop and think about what `this` means, use a local variable instead.

> **Under the hood:** All five are `inline`, so they cost nothing at runtime. They also declare a contract (`callsInPlace`), so you can assign a `val` inside them.

:::deeper The real signatures
Reading the signatures makes the table easy to remember.

```kotlin
inline fun <T, R> T.let(block: (T) -> R): R
inline fun <T, R> T.run(block: T.() -> R): R
inline fun <T, R> with(receiver: T, block: T.() -> R): R
inline fun <T> T.apply(block: T.() -> Unit): T
inline fun <T> T.also(block: (T) -> Unit): T
```

- `(T) -> R` means the object comes in as a parameter, so you call it `it`.
- `T.() -> R` is a lambda with receiver, so the object is `this`.
- Returning `R` gives the lambda result. Returning `T` gives the object back.
:::

:::check
Q: What is `x` in `val x = "abc".apply { uppercase() }`?
A: `"abc"`. `apply` returns the receiver, and the uppercased string made inside is thrown away.
Q: Spot the bug: `token?.let { refresh(it) } ?: logout()`, where `refresh` returns `null` when it fails.
A: When the token exists but refresh fails, `let` returns null, so `logout()` also runs. Use `if (token != null) refresh(token) else logout()`.
Q: Interview: apply vs also, when would you pick each?
A: `apply` when you configure the object with its own members, using `this`. `also` when you do a side effect with the object, like logging or validation, using `it`. Both return the object.
:::

## Classes and objects

Constructors, inheritance, interfaces and the `object` keyword, with the Android traps around each.

:::tldr
- Classes are `final` by default; mark a class and its members `open` to allow overriding.
- Property initializers and `init` blocks run top to bottom, after the superclass constructor.
- `object` is a lazy thread-safe singleton; a `companion object` holds "static-like" members; `inner` classes hold the outer instance.
:::

### Constructors and init

The primary constructor sits in the class header. Parameters marked `val` or `var` become properties.

```kotlin
class User(val id: String, var name: String, age: Int) {
    val isAdult = age >= 18                // uses a plain constructor param
    init { require(id.isNotBlank()) }      // runs during construction

    constructor(id: String) : this(id, "Guest", 0)  // secondary
}
```

- A secondary constructor must call the primary one with `this(...)`.
- Property initializers and `init` blocks run in the order they appear.
- Plain parameters like `age` are visible in initializers but are not stored.

### open, final and override

Classes and members are `final` by default. This is the opposite of Java.

```kotlin
open class Base(val id: String) {
    open fun describe() = "Base $id"
    fun fixed() = "cannot override"
}
class Child(id: String, val extra: Int) : Base(id) {
    override fun describe() = "Child $id $extra"
}
```

An `override` member is itself open. Write `final override` to stop further overriding.

> **Pitfall:** Do not call `open` members from a constructor or `init`. The subclass override runs before the subclass fields are set, so it can see `null` in a non-null property.

### Abstract classes and interfaces

An abstract class can have state, a constructor and abstract members. A class can extend only one.

An interface can have abstract members, default method bodies and properties. It cannot store state, so it has no backing fields. A class can implement many.

```kotlin
interface Clickable {
    val label: String                     // abstract property
    fun click() = println("clicked $label") // default body
}
interface Focusable { fun click() = println("focus") }

class Button : Clickable, Focusable {
    override val label = "OK"
    override fun click() {                // must resolve the clash
        super<Clickable>.click()
        super<Focusable>.click()
    }
}
```

When two interfaces give the same default method, you must override it. You pick a parent with `super<Name>`.

### object and companion object

- `object Foo` is a singleton. It is created lazily and thread-safely on first access, through JVM class initialization.
- A `companion object` lives inside a class and holds "static-like" members. It is still a real object, so it can implement interfaces.
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

> **Interview:** "How is a companion object different from Java `static`?" It is a real singleton object, reached through a static `Companion` field. Its members are instance methods unless you add `@JvmStatic`, `@JvmField` or `const`. Because it is an object, it can implement interfaces and receive extensions.

### Nested vs inner classes

- A nested class (the default) has no reference to the outer instance. It is like a Java `static` nested class.
- An `inner` class holds a reference to the outer instance. It can use outer members, and reach the outer object as `this@Outer`.

```kotlin
class Adapter(val title: String) {
    class Holder { /* cannot see title */ }
    inner class Row { fun text() = title }   // holds Adapter
}
```

> **Pitfall:** An `inner` class inside an Activity always holds the Activity. Lambdas and anonymous objects hold it when they use its members. If they outlive the Activity, it leaks. Prefer nested classes and pass in only what you need.

:::deeper Initialization order in detail
```kotlin
open class Base {
    init { println("Base init: ${describe()}") }
    open fun describe() = "base"
}
class Child : Base() {
    val tag: String = "child"
    init { println("Child init") }
    override fun describe() = "tag=$tag"
}
Child()
```

This prints `Base init: tag=null`, then `Child init`.

1. The base class constructor and its `init` blocks run first.
2. `describe()` is virtual, so the child's version runs.
3. The child's `tag` field is not set yet, so it holds `null`, even though its type is `String`.
4. Then the child's initializers and `init` blocks run in order.
:::

:::check
Q: What does `Child()` print if `Base`'s `init` calls an open `describe()` that `Child` overrides to return its `val tag = "child"`?
A: It prints `tag=null`. The base constructor runs before the child sets `tag`, so the field is still null.
Q: Inside `class Adapter(val title: String)`, why can a plain `class Holder` not read `title`, and what is the cost of fixing it with `inner`?
A: A nested class has no reference to the outer instance. `inner` adds that reference, which keeps the outer object alive and can leak it.
Q: Interview: Abstract class or interface, how do you choose?
A: Use an interface for a capability many unrelated classes can share; it can have default methods but no state. Use an abstract class when subclasses share state or constructor logic, accepting single inheritance.
:::

## Data, sealed, enum and value classes

Four special class kinds that model data and states, and the traps in each.

:::tldr
- `data class` generates `equals`, `hashCode`, `toString`, `copy` and `componentN` from primary constructor properties only.
- `sealed` types have a closed set of subtypes, so `when` can be exhaustive without `else`.
- Use `entries` on enums, and `@JvmInline value class` for type-safe wrappers with no allocation in most cases.
:::

### Data classes

A `data class` gets `equals`, `hashCode`, `toString`, `copy` and `component1..N`. They are built from the primary constructor properties only.

```kotlin
data class User(val id: Long, val name: String) {
    var lastSeen: Long = 0     // NOT in equals/hashCode/toString/copy
}
val a = User(1, "Ana")
val b = a.copy(name = "Bea")   // new object, other fields copied
val (id, name) = a             // destructuring with componentN
```

Rules: the primary constructor needs at least one parameter, and all of them must be `val` or `var`. A data class cannot be `open`, `abstract`, `sealed` or `inner`.

> **Pitfall:** `copy()` is shallow. A data class holding a `MutableList` shares that same list with its copy.

> **Pitfall:** Properties in the class body are ignored by `equals`. Two users with different `lastSeen` values are still equal.

> **Note:** Since Kotlin 2.0.20 the compiler warns when a data class has a private constructor but a public `copy()`, because `copy` would bypass the constructor. `@ConsistentCopyVisibility` makes `copy` match the constructor.

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
- Sealed interface: a class can implement several. Enums and objects can implement it too. Prefer it unless you need shared state.
- `data object` gives a singleton a readable `toString` (`"Loading"`) and a proper `equals`.

> **Tip:** Avoid `else` in a `when` over a sealed type. Then a new subtype causes compile errors everywhere you forgot to handle it. That is the whole point.

### Enum classes

```kotlin
enum class Priority(val weight: Int) {
    LOW(1),
    HIGH(10) { override fun label() = "Urgent" };

    open fun label() = name.lowercase()
}
Priority.entries.forEach { println(it) }   // prefer entries over values()
Priority.valueOf("LOW")                    // throws if the name is wrong
```

Use `entries`. It returns a pre-allocated read-only list. `values()` creates a new array on every call.

Enum or sealed? Enum constants are single instances that all have the same shape. Sealed subtypes can be different classes with different data, and you can create many instances of each.

### Value classes

A value class wraps one value. In most cases there is no wrapper object at runtime. You get type safety for free.

```kotlin
@JvmInline
value class UserId(val raw: String) {
    init { require(raw.isNotBlank()) }
}

fun load(id: UserId) { }   // you cannot pass a random String by mistake
```

At runtime `UserId` is usually just a `String`. It gets boxed into a real object when:

- it is used as a nullable type (`UserId?`),
- it is used as a generic type argument (`List<UserId>`),
- it is used through an interface it implements.

> **Under the hood:** Functions taking value classes get mangled JVM names like `load-AbC123(String)`. This avoids a clash between `load(UserId)` and `load(String)`, but Java cannot call them easily. Add `@JvmName` for a Java-friendly name.

:::deeper Guard conditions in when (Kotlin 2.2)
Kotlin 2.2 made guard conditions stable. A branch can add an `if` after the type check.

```kotlin
fun render(state: UiState) = when (state) {
    is UiState.Error if state.message.isBlank() -> showGeneric()
    is UiState.Error -> showError(state.message)
    is UiState.Success -> showList(state.items)
    UiState.Loading -> showSpinner()
}
```

- The guard runs only after the type check matches, so `state` is already smart-cast.
- Exhaustiveness still works. The plain `is UiState.Error` branch covers the rest of that type.
:::

:::check
Q: `data class User(val id: Int) { var name = "" }`. Is `User(1).apply { name = "a" } == User(1).apply { name = "b" }` true or false?
A: `true`. `name` is declared in the body, so generated `equals` ignores it.
Q: You add `data object Empty : UiState` to a sealed interface. What happens to a `when` with no `else`, and to one with `else`?
A: The one without `else` stops compiling until you handle `Empty`. The one with `else` compiles silently and may do the wrong thing.
Q: Interview: Enum or sealed interface for screen state?
A: Sealed interface, because states carry different data, like a list for `Success` and a message for `Error`. Enums fit fixed sets of same-shaped constants, like sort orders.
:::

## Delegation

How the `by` keyword hands work to another object, for whole classes and for single properties.

:::tldr
- `class A(b: B) : B by b` generates every method of `B` to forward to `b`, except the ones you override.
- `val x by d` turns the getter into `d.getValue(...)` and the setter into `d.setValue(...)`.
- The stdlib gives you `lazy`, `observable`, `vetoable`, `notNull` and map delegates; writing your own is a few lines.
:::

### Class delegation

`by` lets a class implement an interface by forwarding calls to another object. It is the language's built-in "composition over inheritance".

```kotlin
class LoggingList<T>(private val inner: MutableList<T> = mutableListOf()) :
    MutableList<T> by inner {
    override fun add(element: T): Boolean {
        println("add $element")
        return inner.add(element)
    }
}
```

The compiler writes every `MutableList` method for you. Each one calls `inner`, except `add`, which you wrote yourself.

> **Pitfall:** The delegate does not know about your overrides. If `inner.addAll` calls `add` internally, it calls its own `add`, not yours. This is not inheritance.

Class delegation only works with interfaces, not with classes.

### Delegated properties

`val x by delegate` hands the property's get (and set, for `var`) to another object.

- Reading `x` calls `delegate.getValue(thisRef, property)`.
- Writing `x` calls `delegate.setValue(thisRef, property, value)`.

You already use this on Android:

```kotlin
private val viewModel: HomeViewModel by viewModels()  // Lazy<HomeViewModel>
var count by remember { mutableStateOf(0) }           // State getValue/setValue
```

### Standard delegates

```kotlin
import kotlin.properties.Delegates

val config by lazy { loadConfig() }        // computed once, on first read

var name: String by Delegates.observable("init") { _, old, new ->
    println("$old -> $new")                // runs after every assignment
}
var age: Int by Delegates.vetoable(0) { _, _, new -> new >= 0 }  // reject negatives
var id: Int by Delegates.notNull()         // like lateinit, works for Int too
```

- `lazy`: compute once on first read.
- `observable`: callback after every assignment.
- `vetoable`: callback before the change; return `false` to reject it.
- `notNull`: set later, any type, throws if read before set.

> **Pitfall:** `observable` fires on every assignment, even when the new value equals the old one. Compare `old != new` yourself if that matters.

### Map delegation and property aliases

A property can read its value from a map. The property name is the key.

```kotlin
class Config(map: Map<String, Any?>) {
    val host: String by map        // reads map["host"]
    val port: Int by map           // ClassCastException if not an Int
}

class Profile { var name = ""; var alias: String by this::name }
```

Map delegation is handy for parsed JSON or config. A `var` needs a `MutableMap`. The `this::name` form delegates to another property, which helps when you rename a property and keep the old name.

### Writing your own delegate

Implement `ReadWriteProperty` (or `ReadOnlyProperty` for a `val`). This one stores a string in `SharedPreferences`.

```kotlin
class StringPref(
    private val sp: SharedPreferences,
    private val key: String,
) : ReadWriteProperty<Any?, String> {
    override fun getValue(thisRef: Any?, property: KProperty<*>) =
        sp.getString(key, "") ?: ""
    override fun setValue(thisRef: Any?, property: KProperty<*>, value: String) =
        sp.edit().putString(key, value).apply()
}

class Prefs(sp: SharedPreferences) {
    var token: String by StringPref(sp, "token")
}
```

You do not have to implement the interface. Any object with `operator fun getValue` (and `setValue`) works, even as an extension. That is how `Lazy` and Compose's `State` become delegates.

> **Tip:** Use `property.name` as the default key. Then `var token by stringPref()` stores under `"token"` with no string to mistype.

:::deeper Under the hood and provideDelegate
For each delegated property the compiler creates a hidden field named like `token$delegate`. It holds the delegate object. The generated getter calls `getValue` on it.

```kotlin
// What `var token by StringPref(sp, "token")` roughly becomes
private val `token$delegate` = StringPref(sp, "token")
var token: String
    get() = `token$delegate`.getValue(this, ::token)
    set(v) = `token$delegate`.setValue(this, ::token, v)
```

- The compiler avoids building the `KProperty` object in many cases where the delegate never reads it.
- `provideDelegate` is an optional operator. It runs once when the property is created, before any read. Use it to validate the property or pick a delegate based on its name.
:::

:::check
Q: `LoggingList` above overrides only `add`. Does `list.addAll(listOf(1, 2))` print anything?
A: No. `addAll` is forwarded to `inner`, and `inner` calls its own `add`, not your override.
Q: `var x by Delegates.observable(0) { _, o, n -> println("$o->$n") }`. What does `x = 0` print?
A: `0->0`. `observable` fires on every assignment, even when the value does not change.
Q: Interview: How does `val vm: MyViewModel by viewModels()` work?
A: `viewModels()` returns a `Lazy<MyViewModel>`, and the stdlib has a `getValue` extension on `Lazy`. So the first read creates the ViewModel through a `ViewModelProvider`, and later reads reuse it.
:::

## Generics

How to write type-safe generic code, and what `in`, `out` and `*` really mean.

:::tldr
- Generic types are invariant by default; `out T` makes a producer covariant and `in T` makes a consumer contravariant.
- Variance can go on the class (declaration-site) or on one usage (use-site, like `Array<out T>`).
- Type arguments are erased at runtime, so use `reified` or pass a `KClass` when you need the type.
:::

### Basics and upper bounds

```kotlin
class Box<T>(val value: T)

fun <T : Comparable<T>> maxOf(a: T, b: T) = if (a > b) a else b

fun <T> sortAndPrint(x: List<T>) where T : CharSequence, T : Comparable<T> {
    println(x.sorted())
}
```

- `T : Comparable<T>` is an upper bound. `T` must be comparable.
- `where` lets you list several bounds.
- A plain `T` has the upper bound `Any?`, so it may be null. Write `T : Any` to forbid null.

### Invariance: the default

A `Box<Cat>` is not a `Box<Animal>`, even though a `Cat` is an `Animal`. Generic types are invariant by default.

That is a safety rule. Look at a mutable list:

```kotlin
val cats: MutableList<Cat> = mutableListOf(Cat())
// val animals: MutableList<Animal> = cats   // compile error, and good
// animals.add(Dog())                        // would put a Dog among cats
```

If the assignment were allowed, you could add a `Dog` to a list of cats.

### out and in

Variance relaxes that rule when it is safe.

- `out T` (covariant): the type only produces `T`. You can return `T`, not accept it. So `Source<Cat>` is a `Source<Animal>`.
- `in T` (contravariant): the type only consumes `T`. You can accept `T`, not return it. So `Sink<Animal>` is a `Sink<Cat>`.
- No modifier (invariant): you can read and write. No subtyping either way.

```kotlin
interface Source<out T> { fun next(): T }
interface Sink<in T> { fun put(item: T) }

val animals: Source<Animal> = catSource   // ok: out
val catSink: Sink<Cat> = animalSink       // ok: in
```

Memory trick: Producer `out`, Consumer `in`. It is Java's PECS rule (`? extends` and `? super`).

Read-only `List<out E>` is covariant. That is why `List<String>` can be passed as `List<Any>`, and why an empty `List<Nothing>` fits any `List<User>`. `Comparator<in T>` is contravariant, so a `Comparator<Animal>` can sort cats.

### Declaration-site vs use-site variance

- Declaration-site: you put `out` or `in` on the class's type parameter. It applies everywhere. Java does not have this.
- Use-site (type projection): you put it on one usage, when the class itself is invariant.

```kotlin
fun copy(from: Array<out Any>, to: Array<in Any>) {
    for (i in from.indices) to[i] = from[i]
}
```

`Array<out Any>` means "I will only read from this". Writing `from[0] = x` would not compile.

### Star projection

`List<*>` means "a list of some type I do not know". You can read items as `Any?`. You cannot safely write to it. It is like Java's `List<?>`.

```kotlin
fun printAll(items: List<*>) = items.forEach { println(it) }
if (x is List<*>) { }          // allowed
// if (x is List<String>) { }  // not allowed: the type is erased
```

### Type erasure

On the JVM, type arguments are removed at runtime. `List<String>` and `List<Int>` are both just `List`. That is why you cannot check `is List<String>`.

You have two ways around it:

1. Make the function `inline` with a `reified` type parameter (see lesson 5).
2. Pass the class explicitly as `KClass<T>` or `Class<T>`.

```kotlin
inline fun <reified T> List<*>.firstOfType(): T? = firstOrNull { it is T } as T?
fun <T : Any> parse(json: String, type: KClass<T>): T = TODO()
```

:::deeper @UnsafeVariance
Sometimes a covariant type must take `T` as a parameter but never stores it. The compiler would reject that, so you silence it with `@UnsafeVariance`.

```kotlin
public interface List<out E> : Collection<E> {
    override fun contains(element: @UnsafeVariance E): Boolean
    fun indexOf(element: @UnsafeVariance E): Int
}
```

`contains` only compares. It never stores the element, so the variance promise still holds. Use this rarely. If you are wrong, you can get a `ClassCastException` at runtime.
:::

:::check
Q: Why does `val a: MutableList<Any> = mutableListOf<String>()` fail while `val b: List<Any> = listOf<String>()` compiles?
A: `MutableList` is invariant because you could add a non-String through `a`. `List` is declared `List<out E>`, read-only and covariant, so it is safe.
Q: Can you write `fun <T> isType(x: Any) = x is T`? How do you fix it?
A: No, `T` is erased at runtime. Make it `inline fun <reified T> isType(x: Any) = x is T`.
Q: Interview: Explain `in` and `out` with a real example.
A: `List<out E>` only produces items, so `List<Cat>` is a `List<Animal>`. `Comparator<in T>` only consumes items, so a `Comparator<Animal>` can sort a `List<Cat>`. Producer out, consumer in.
:::

## Collections and sequences

Read-only vs mutable collections, the operators you use daily, and when a lazy `Sequence` wins.

:::tldr
- `List` is read-only, not immutable: the same object may be a `MutableList` underneath.
- Collection operators are eager and create a new list at every step.
- A `Sequence` is lazy and processes one element at a time through the whole chain; use it for big data, long chains or early exit.
:::

### Read-only vs mutable

| Read-only | Mutable | Factory |
|---|---|---|
| `List<T>` | `MutableList<T>` | `listOf` / `mutableListOf` |
| `Set<T>` | `MutableSet<T>` | `setOf` / `mutableSetOf` |
| `Map<K, V>` | `MutableMap<K, V>` | `mapOf` / `mutableMapOf` |

Read-only does not mean immutable. `List<T>` just has no methods to change it. The same object may be a `MutableList` underneath, and someone else can change it.

```kotlin
val mutable = mutableListOf(1, 2)
val readOnly: List<Int> = mutable
mutable.add(3)
println(readOnly)   // [1, 2, 3]: same object
```

> **Tip:** Expose `List<T>` from your APIs and keep `MutableList<T>` private. For true immutability, use `kotlinx.collections.immutable` (`persistentListOf`), which also helps Compose stability.

> **Under the hood:** On the JVM, `List` and `MutableList` both map to `java.util.List`. A Java method can cast and change your "read-only" list.

### Operators you use daily

```kotlin
users.filter { it.active }.map { it.name }
users.mapNotNull { it.email }               // map and drop nulls
users.flatMap { it.roles }                  // flatten lists of lists
users.sortedByDescending { it.score }.take(10)
users.firstOrNull { it.isAdmin }
users.any { it.banned }; users.all { it.verified }; users.count { it.active }
users.sumOf { it.score }
users.distinctBy { it.email }
users.chunked(20); users.windowed(3); users.zip(scores)
```

### Grouping and folding

```kotlin
users.groupBy { it.country }              // Map<Country, List<User>>
users.associateBy { it.id }               // Map<Id, User>
users.associate { it.id to it.name }      // Map<Id, String>
ids.associateWith { loadUser(it) }        // Map<Id, User>, keys = elements
val (adults, minors) = users.partition { it.age >= 18 }
users.fold(0) { acc, u -> acc + u.score } // start value, any result type
scores.reduce { acc, s -> acc + s }       // first element is the start
```

- `groupBy` keeps every element per key. `associateBy` keeps only the last one per key.
- `fold` takes a start value, so it works on an empty list. `reduce` throws on an empty list.
- `partition` returns a `Pair` of two lists, which you can destructure.

### Eager lists

Each operator on a `List` runs right away and builds a new list. A chain of three operators builds three lists.

That is fine for small collections. It is wasteful for big ones.

### Sequences

A `Sequence` is lazy. Intermediate operations like `map` and `filter` do nothing until a terminal operation, like `toList`, `first` or `sum`, asks for values. Then each element goes through the whole chain, one at a time.

```kotlin
listOf(1, 2, 3).asSequence()
    .map { println("map $it"); it * 2 }
    .filter { println("filter $it"); it > 2 }
    .first()
// map 1, filter 2, map 2, filter 4  -> returns 4
```

The third element is never touched. With a plain list, all three would be mapped, then all three filtered.

| | List | Sequence |
|---|---|---|
| Evaluation | Eager, step by step | Lazy, element by element |
| Intermediate collections | One per operation | None |
| Early exit (`first`, `take`) | Earlier steps still run fully | Stops early |
| Overhead | Low per step | Small per element |
| Best for | Small data, one or two steps | Large or infinite data, long chains |

```kotlin
val fib = generateSequence(1 to 1) { (a, b) -> b to a + b }.map { it.first }
fib.take(10).toList()   // infinite sequence, safe because take is lazy
```

> **Pitfall:** A sequence with no terminal operation does nothing. And `sorted()` must read every element first, so it loses most of the lazy benefit.

> **Note:** Sequences are synchronous and pull-based. `Flow` is the asynchronous, suspending cousin. See the Coroutines and Flow notes.

:::deeper Arrays and builders
- `Array<Int>` holds boxed `Integer`s. `IntArray` is a primitive `int[]`. Prefer primitive arrays in hot code.
- Arrays do not override `equals`. Use `contentEquals` to compare contents.
- `buildList { add(1); addAll(more) }` builds a list with a private mutable list inside, then hands back a read-only one.
- `ArrayList(capacity)` avoids resizing when you know the size up front.
- `listOf(a, b)` on the JVM returns a fixed-size `Arrays.asList` wrapper.
:::

:::check
Q: Run the `map`/`filter`/`first` example on a plain list, with no `asSequence()`. What prints?
A: `map 1, map 2, map 3`, then `filter 2, filter 4`. The list maps everything first, then filters until it finds the first match, `4`.
Q: Two users share the same email. What do `groupBy { it.email }` and `associateBy { it.email }` give for that key?
A: `groupBy` gives a list with both users. `associateBy` keeps only the last user, so the first one is silently lost.
Q: Interview: When is a `Sequence` slower than a `List`?
A: For small collections or one or two operations. A sequence adds per-element overhead from iterator objects and non-inlined lambdas, so it wins only with big data, long chains or early exit.
:::

## Equality and exceptions

The two kinds of equality, the `equals`/`hashCode` contract, and how Kotlin handles errors without checked exceptions.

:::tldr
- `==` calls `equals` and is null-safe; `===` checks if two references are the same object.
- If `a == b`, their hash codes must match; never mutate an object while it is a `HashMap` key.
- Kotlin has no checked exceptions; `try` and `throw` are expressions, and `runCatching` catches too much in coroutines.
:::

### == vs ===

- `==` is structural equality. `a == b` compiles to `a?.equals(b) ?: (b === null)`. It is null-safe.
- `===` is referential equality. It is true only when both sides are the same object.

```kotlin
val a = User(1, "Ana")
val b = User(1, "Ana")
a == b    // true: data class equals compares properties
a === b   // false: two different objects
```

> **Pitfall:** Never use `===` on numbers. With boxed `Int?` values, small numbers may share one cached `Integer` object and larger ones usually do not. The result depends on the value, not on your logic.

### The equals and hashCode contract

1. If `a == b`, then `a.hashCode() == b.hashCode()` must be true.
2. Equal hash codes do not mean the objects are equal.
3. `equals` must be reflexive, symmetric, transitive and consistent.

If you override one, override both. Data classes generate both from the primary constructor, so the contract holds automatically.

> **Pitfall:** A data class with an `Array` property compares that array by reference, because arrays do not override `equals`. Use a `List`, or override with `contentEquals` and `contentHashCode`.

> **Pitfall:** Do not put an object in a `HashSet`, or use it as a `HashMap` key, and then change it. Its hash code changes and the set can no longer find it. Keep keys immutable.

### No checked exceptions

Kotlin has no checked exceptions. You never have to declare or catch anything. The designers saw that in large Java codebases, checked exceptions led to empty `catch` blocks and noisy signatures, without making code more reliable.

For Java callers that expect a checked exception, add `@Throws(IOException::class)`.

### try and throw are expressions

`try` returns a value. `throw` has type `Nothing`, so it fits anywhere.

```kotlin
val n: Int? = try { s.toInt() } catch (e: NumberFormatException) { null }

val user = cache[id] ?: throw NotFoundException(id)

require(age >= 0) { "age must be >= 0" }   // IllegalArgumentException
check(isConnected) { "not connected" }     // IllegalStateException
val u = requireNotNull(user) { "no user" } // returns a non-null value
error("unreachable")                       // throws IllegalStateException
```

- Use `require` for bad arguments and `check` for bad state.
- The value of `try` is the last expression of `try` or `catch`. A `finally` block does not change it.
- `use { }` closes a `Closeable` for you, like Java's try-with-resources.

### runCatching and Result

```kotlin
val result: Result<User> = runCatching { api.fetchUser(id) }

result.map { it.name }
    .onSuccess { show(it) }
    .onFailure { log(it) }

val name = result.getOrElse { "guest" }
val maybe = result.getOrNull()
```

> **Pitfall:** `runCatching` catches every `Throwable`. That includes `CancellationException`, which breaks coroutine cancellation, and `Error`s like `OutOfMemoryError`. In suspend code, catch specific exceptions or rethrow `CancellationException`.

For domain errors, many teams prefer a sealed result type. It is exhaustive and typed, while `Result` only carries a `Throwable`.

```kotlin
sealed interface LoadResult {
    data class Success(val user: User) : LoadResult
    data object NotFound : LoadResult
    data class NetworkError(val code: Int) : LoadResult
}
```

:::deeper Floating point equality
- When both sides are statically typed as `Double` (or `Double?`), `NaN == NaN` is `false` and `-0.0 == 0.0` is `true`. That follows the IEEE 754 standard.
- When the values are typed as `Any`, `Comparable` or a generic `T`, Kotlin uses `equals` instead. Then `NaN` equals itself and `-0.0` is not equal to `0.0`.
- So the same two numbers can compare differently depending on their static type. For money, use `Long` cents or `BigDecimal`, not `Double`.
:::

:::check
Q: `val x: Int? = 1000; val y: Int? = 1000`. What are `x == y` and `x === y`?
A: `x == y` is `true`. `x === y` is usually `false`, because 1000 is outside the JVM's small `Integer` cache; never rely on `===` for numbers.
Q: Spot the bug: `suspend fun load() = runCatching { api.get() }`.
A: It also catches `CancellationException`, so a cancelled coroutine keeps running as if it failed normally. Catch specific exceptions, or rethrow `CancellationException`.
Q: Interview: Why does Kotlin not have checked exceptions, and how do you model expected errors instead?
A: In practice they caused empty catch blocks and noisy signatures without better reliability. Model expected failures as values, with `Result` or a sealed result type, and use `@Throws` for Java callers.
:::

## Visibility and Java interop

Who can see what in Kotlin, and the annotations that make Kotlin code pleasant to call from Java.

:::tldr
- `internal` means "same module"; on the JVM it compiles to `public` with mangled names.
- `@JvmStatic`, `@JvmField`, `@JvmOverloads`, `@JvmName` and `@Throws` shape what Java sees.
- Java SAM interfaces take lambdas directly; Kotlin interfaces need `fun interface` for that.
:::

### Visibility modifiers

| Modifier | Top-level declaration | Class member |
|---|---|---|
| `public` (default) | Everywhere | Everywhere |
| `internal` | Same module | Same module |
| `protected` | Not allowed | Subclasses only |
| `private` | Same file | Same class |

Two differences from Java stand out:

- The default is `public`, not package-private. Kotlin has no package-private visibility.
- `protected` means subclasses only. Other classes in the same package cannot see it.

### Modules and internal

A module is a set of files compiled together: a Gradle module or source set, or a Maven project. In a multi-module Android app, `internal` is the main tool to hide the details of a feature module.

```kotlin
// :feature:profile module
internal class ProfileMapper { }          // invisible to :app
class ProfileEntry(private val mapper: ProfileMapper)  // error: exposes internal
```

A public declaration cannot expose an internal type in its signature. The compiler catches that.

> **Under the hood:** The JVM has no "module" visibility. `internal` members compile to `public` in bytecode, and internal functions get mangled names like `doWork$mylib_release`. Java code can still call them, just awkwardly.

### Java interop annotations

```kotlin
class Analytics {
    companion object {
        @JvmStatic fun get(): Analytics = instance  // Java: Analytics.get()
        @JvmField val VERSION = "1.0"               // Java: Analytics.VERSION
        const val TAG = "Analytics"                 // static final, inlined
    }
}

class MyView @JvmOverloads constructor(
    ctx: Context, attrs: AttributeSet? = null, defStyle: Int = 0,
) : View(ctx, attrs, defStyle)                     // Java sees 3 constructors
```

- `@JvmStatic`: makes a real static method in the outer class. The companion method stays too.
- `@JvmField`: exposes the property as a plain field, with no getter or setter. It is not allowed on `private`, `open`, `const` or delegated properties.
- `@JvmOverloads`: generates overloads for the default arguments.
- `@JvmName`: renames the JVM method, or the file class when used as `@file:JvmName("StringUtils")`.
- `@Throws`: declares checked exceptions so Java callers can catch them.

`@JvmName` also fixes clashes caused by erasure:

```kotlin
fun List<String>.total(): Int = size
@JvmName("totalInts")
fun List<Int>.total(): Int = sum()   // without it, both erase to total(List)
```

> **Pitfall:** `@JvmOverloads` with `defStyle = 0` on a View that extends a styled widget (like a Material button) can drop its theme style. Pass the widget's real default style attribute instead.

### SAM conversion and fun interface

A SAM interface has a Single Abstract Method. You can create one from a lambda.

```kotlin
// Java interfaces work directly
button.setOnClickListener { v -> handle(v) }
executor.execute { work() }

// Kotlin interfaces must be declared `fun interface`
fun interface Validator {
    fun validate(input: String): Boolean
}
val notEmpty = Validator { it.isNotEmpty() }
```

For Kotlin-only code, a plain function type like `(String) -> Boolean` is often enough. Use `fun interface` when you want a named type, Java callers, or extra default methods.

### Platform types, a reminder

Values from Java without nullability annotations arrive as platform types, like `String!`. Kotlin lets you treat them as nullable or not, and does not check. Declare the type explicitly where Java code hands you a value. See lesson 4.

### Other things Java sees

- Top-level functions live in a class named after the file, like `UtilsKt`.
- A property `name` becomes `getName()`/`setName()`. A property `isActive` becomes `isActive()`/`setActive()`.
- Java getters and setters appear as Kotlin properties: `view.visibility = View.GONE`.
- A companion member without `@JvmStatic` is called as `Repo.Companion.create()` from Java.
- An `object` member is called as `Foo.INSTANCE.bar()` unless it has `@JvmStatic`.

:::deeper Interfaces and default methods
- In recent Kotlin versions, default bodies in Kotlin interfaces compile to real JVM default methods. The `-jvm-default` compiler option controls this.
- A Java name that is a Kotlin keyword, like a method named `is` or `in`, must be wrapped in backticks when you call it from Kotlin.
- Kotlin `Unit`-returning functions look like `void` methods to Java. Function-type parameters look like `Function1<A, Unit>`, so Java lambdas must `return Unit.INSTANCE`. A `fun interface` avoids that.
:::

:::check
Q: Java code calls `Repo.create()`, where `create` is in Repo's companion object, and it does not compile. Why, and what are the two fixes?
A: Without `@JvmStatic`, `create` is an instance method on the companion. Call `Repo.Companion.create()` from Java, or add `@JvmStatic`.
Q: Why can Java code in another module call your `internal` Kotlin function at all?
A: The JVM has no module visibility, so `internal` compiles to `public` with a mangled name. Kotlin enforces the rule; Java does not.
Q: Interview: `fun interface` or a function type like `(String) -> Boolean`, which do you use?
A: A function type for simple Kotlin-only callbacks. A `fun interface` when you want a named, documented type, Java callers with clean lambdas, or default methods alongside the single abstract one.
:::

## Contracts and DSLs

How contracts help smart casts, and how lambdas with receivers let you build type-safe DSLs.

:::tldr
- Contracts tell the compiler facts it cannot infer, like "if this returns true, the value is not null".
- A lambda with receiver, `T.() -> Unit`, runs as if it were a member of `T`; it is the core of every Kotlin DSL.
- `@DslMarker` stops inner blocks from silently calling methods of outer receivers.
:::

### Contracts

Some functions promise things the compiler cannot see on its own. A contract writes that promise down. Then smart casts and `val` initialization work through the call.

```kotlin
@OptIn(ExperimentalContracts::class)
fun String?.isPresent(): Boolean {
    contract { returns(true) implies (this@isPresent != null) }
    return this != null && isNotEmpty()
}

fun show(s: String?) {
    if (s.isPresent()) println(s.length)   // smart cast works
}
```

The second common kind says how often a lambda runs:

```kotlin
val x: Int
run { x = 42 }   // ok: run promises to call the block exactly once
println(x)
```

The stdlib uses contracts in `require`, `check`, `requireNotNull`, `isNullOrEmpty`, `let`, `run`, `apply` and more. Writing your own still needs `@OptIn(ExperimentalContracts::class)`.

> **Pitfall:** The compiler does not verify a contract. A wrong contract gives you unsafe smart casts and runtime crashes.

### Lambdas with receiver

A lambda of type `T.() -> Unit` runs as if it were a member of `T`. Inside it, `this` is the receiver, so you call `T`'s members without a prefix.

```kotlin
fun myBuildString(block: StringBuilder.() -> Unit): String {
    val sb = StringBuilder()
    sb.block()            // call it on the receiver
    return sb.toString()
}

val html = myBuildString {
    append("<p>")         // this = StringBuilder
    append("Hello")
    append("</p>")
}
```

This is how `apply`, `buildString`, Gradle Kotlin DSL and Compose scopes like `RowScope` work.

### Building a tiny DSL

Here is a small menu DSL. Each builder is a class. Each block is a lambda with that class as receiver.

```kotlin
@DslMarker annotation class MenuDsl

@MenuDsl class Menu {
    val items = mutableListOf<Item>()
    fun item(title: String, block: Item.() -> Unit = {}) {
        items += Item(title).apply(block)
    }
}

@MenuDsl class Item(val title: String) {
    var icon: Int = 0
    var onClick: () -> Unit = {}
}

fun menu(block: Menu.() -> Unit): Menu = Menu().apply(block)
```

And here is how you use it:

```kotlin
val m = menu {
    item("Settings") {
        icon = R.drawable.ic_settings
        onClick = { openSettings() }
        // item("Nested")   // compile error thanks to @MenuDsl
    }
    item("Logout")
}
```

### Why @DslMarker matters

Inside `item("Settings") { }`, two receivers are in scope: the `Item` and the outer `Menu`. Without the marker, calling `item(...)` there would quietly resolve to the outer `Menu`. You would add a sibling item by mistake.

`@DslMarker` forbids implicit calls to an outer receiver of the same DSL. You can still reach it explicitly with a label, like `this@menu.item(...)`.

### DSLs you already use on Android

- `build.gradle.kts`: blocks like `android { defaultConfig { } }` are lambdas with receivers on Gradle extension objects.
- Compose: `LazyColumn { items(list) { } }` takes a `LazyListScope.() -> Unit`, which is why `items` is only callable inside that block.
- Compose layouts: inside `Row { }`, the `RowScope` receiver adds modifiers like `Modifier.weight(1f)` that make no sense elsewhere.
- Stdlib: `buildList { }`, `buildMap { }` and `buildString { }` give you a mutable receiver and hand back the finished result.

The pattern is always the same: a scope class decides which functions are available, and a lambda with that receiver is the block you write.

> **Tip:** Make the top-level builder function `inline`, like `inline fun menu(block: Menu.() -> Unit)`. The outer lambda then costs nothing at runtime.

> **Note:** Kotlin 2.2 added context parameters as a preview feature. They replace the old experimental context receivers. Treat them as preview and do not rely on them in production code yet.

:::deeper Contract kinds at a glance
| Contract | Meaning |
|---|---|
| `returns(true) implies (cond)` | If the function returns true, `cond` holds |
| `returns() implies (cond)` | If the function returns at all, `cond` holds |
| `returnsNotNull() implies (cond)` | If the result is non-null, `cond` holds |
| `callsInPlace(block, EXACTLY_ONCE)` | The lambda runs exactly once, right here |
| `callsInPlace(block, AT_MOST_ONCE)` | The lambda runs zero or one time |

```kotlin
@OptIn(ExperimentalContracts::class)
inline fun <R> once(block: () -> R): R {
    contract { callsInPlace(block, InvocationKind.EXACTLY_ONCE) }
    return block()
}
```

`require(x != null)` uses `returns() implies`, which is why `x` is smart-cast to non-null on the next line.
:::

:::check
Q: Why does `val x: Int; run { x = 1 }; println(x)` compile, when assigning a `val` inside a lambda normally fails?
A: `run` declares a `callsInPlace(EXACTLY_ONCE)` contract. The compiler then knows `x` is assigned exactly once before it is read.
Q: Without `@DslMarker`, what happens when you call `item("x")` inside an `item("Settings") { }` block?
A: It compiles and resolves to the outer `Menu` receiver, so it silently adds a sibling item instead of an error.
Q: Interview: What is the difference between `(T) -> Unit` and `T.() -> Unit`?
A: Both take a `T`. With a receiver, `T` becomes `this` inside the lambda, so you call its members without a prefix, which is what makes DSL code read naturally.
:::

## Under the hood

What common Kotlin features compile to, so you can answer "what does this cost?" with confidence.

:::tldr
- Decompile often: Tools, Kotlin, Show Kotlin Bytecode, then Decompile.
- Data classes, companions and extensions are plain Java classes and static methods underneath.
- `inline` removes lambda objects; ranges in `for` loops become plain counting loops.
:::

### How to look

In Android Studio, open a Kotlin file. Go to Tools, Kotlin, Show Kotlin Bytecode, then press Decompile. You get Java-like code for the file. This is the fastest way to answer "what does this cost?"

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
    public final Point copy(int x, int y) { return new Point(x, y); }
    // plus copy$default(Point, int, int, int mask, Object)
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

The class and its getters are `final`. Only constructor properties appear. Each instance costs the same as a normal class with the same fields.

### when on an enum

A `when` over an enum compiles to a `tableswitch`. It does not switch on `ordinal()` directly. The compiler makes a synthetic class like `MainKt$WhenMappings` with an `int[]` that maps each ordinal to a case number.

```java
switch (WhenMappings.$EnumSwitchMapping$0[priority.ordinal()]) {
    case 1: return "low";
    case 2: return "high";
    default: throw new NoWhenBranchMatchedException();
}
```

The mapping protects you if the enum is reordered and recompiled separately. A `when` on dense `Int` constants uses `tableswitch`; sparse ones use `lookupswitch`. A `when` on strings switches on `hashCode()`, like Java. Anything else becomes an `if`/`else` chain.

### String templates

`"Hi $name, you have ${count + 1} items"` becomes string concatenation. For JVM 9+ targets, the compiler uses `invokedynamic` with `StringConcatFactory`. For older targets it uses `StringBuilder.append` chains. On Android, D8/R8 desugars this for older devices.

### Companion object

```kotlin
class Api { companion object { val URL = "x"; const val V = 2; fun create() = Api() } }
```

```java
public final class Api {
    public static final int V = 2;              // const: static field
    private static final String URL = "x";      // field lives in the outer class
    public static final Api.Companion Companion = new Api.Companion(null);
    public static final class Companion {
        public final String getURL() { return Api.URL; }
        public final Api create() { return new Api(); }
    }
}
```

From Java you must write `Api.Companion.create()` unless you add `@JvmStatic`.

### Inline function

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

### Extension function

`fun String.isEmail()` in `StringUtils.kt` becomes `StringUtilsKt.isEmail(String)`, a static method. The call `s.isEmail()` becomes `StringUtilsKt.isEmail(s)`. There is no wrapper object and no virtual call.

### Performance tips

- Use primitive types and arrays (`IntArray`) in hot code. `Int?` and generics box values.
- Use `inline` for small higher-order helpers called often. Never for large functions.
- Use sequences for long chains over big data or early exit. Use lists for small data.
- Use `const val` for compile-time constants, and `entries` instead of `values()` on enums.
- Avoid non-inline capturing lambdas in hot loops. Each run may allocate.

:::deeper More things worth decompiling
- `object Foo` becomes a class with `public static final Foo INSTANCE`, created in a static initializer.
- `lateinit var` becomes a nullable field. The getter throws `UninitializedPropertyAccessException` if it is null.
- Top-level properties become static fields in `FileKt`, with static getters.
- `for (i in 0 until n)` and `for (i in 0..<n)` compile to a plain counting loop. No `IntRange` object.
- `repeat(n) { }` is inline and becomes a plain loop.
- A non-null public parameter gets an `Intrinsics.checkNotNullParameter` call at the top of the method.
- Value class parameters show up as the underlying type, with a mangled method name.

More performance habits:

- Use `lazy` for expensive one-time setup, and `LazyThreadSafetyMode.NONE` when only one thread touches it.
- Prefer `buildList { }`, `buildString { }` and `ArrayList(capacity)` to avoid repeated copying.
- Check for null once and let smart casts work, instead of repeating `?.` inside loops.
- R8 removes unused code and inlines many small generated getters in release builds.
:::

:::check
Q: Why does a `when` over an enum use a `$WhenMappings` array instead of switching on `ordinal()` directly?
A: If the enum is reordered and recompiled without your file, ordinals change. The mapping array is filled at runtime from the current ordinal of each constant, so your `when` still picks the right branch.
Q: What does `for (i in 0 until n) { }` allocate?
A: Nothing. The compiler turns it into a plain counting loop with no `IntRange` object.
Q: Interview: What does a data class cost compared to a regular class?
A: Only extra methods in the bytecode: `equals`, `hashCode`, `toString`, `copy` and `componentN`. Each instance has the same fields and memory as a normal class, and R8 can strip methods you never call.
:::

## Review and cheat sheet

One screen of everything in this topic, plus practice to lock it in.

:::tldr
- Skim the cheat sheet the night before an interview; each row maps to an earlier lesson.
- Do the five exercises: each one forces you to explain a feature, not just use it.
- When unsure what something costs, decompile it.
:::

### Cheat sheet

| Topic | Remember |
|---|---|
| Types | `Int` is a JVM `int` unless nullable or generic; no implicit widening |
| Special types | `Any` root, `Unit` singleton, `Nothing` never returns, `null` is `Nothing?` |
| Properties | `field` in accessors; `val` fixes the reference only; `const` is inlined |
| lateinit | `var`, non-null, non-primitive, check with `::x.isInitialized` |
| lazy | `val`, synchronized by default, modes `PUBLICATION` and `NONE` |
| Functions | Defaults make `$default`; Java needs `@JvmOverloads` |
| Extensions | Static methods, receiver is the first param, member wins |
| Null safety | `?.` `?:` `!!` `as?`; right side of `?:` can be `return` or `throw` |
| Platform type | `T!` from unannotated Java; declare the type at the boundary |
| inline | Copies body; enables non-local `return` and `reified` |
| noinline / crossinline | Keep as object / inline but no non-local `return` |
| Scope functions | `let`/`also` use `it`; `apply`/`also` return the object |
| Classes | Final by default; do not call `open` members in `init` |
| object / companion | Lazy thread-safe singleton; companion needs `@JvmStatic` for Java |
| data class | Generated from primary constructor only; `copy` is shallow |
| sealed | Closed hierarchy, exhaustive `when`, avoid `else` |
| value class | One value, no allocation, boxes when nullable or generic |
| Delegation | `by` forwards calls; delegate never sees your overrides |
| Variance | `out` producer, `in` consumer, `*` unknown; erased at runtime |
| Collections | Read-only is not immutable; list operators are eager |
| Sequences | Lazy, per element, need a terminal operation |
| Equality | `==` is null-safe `equals`; `===` is same reference |
| Exceptions | None checked; `runCatching` also catches `CancellationException` |
| Visibility | `internal` is per module; compiles to `public`, mangled |
| Interop | `@JvmStatic`, `@JvmField`, `@JvmOverloads`, `@JvmName`, `@Throws` |
| DSL | Lambda with receiver plus `@DslMarker` |

### The pitfalls that come up most

- `?.let { } ?: other` runs `other` when the lambda returns null.
- `runCatching` in suspend code swallows cancellation.
- `inner` classes and capturing lambdas can leak an Activity.
- Data class `equals` ignores body properties, and arrays compare by reference.
- A mutable object used as a `HashMap` key gets lost when it changes.
- `Delegates.observable` fires even when the value did not change.

### Recent language features

- Kotlin 2.0: the K2 compiler is stable, with smarter smart casts and faster builds.
- Kotlin 2.2: guard conditions in `when`, non-local `break` and `continue` in inline lambdas, and multi-dollar strings like `$$"price: $$amount"` for text with literal `$` signs are stable.

### Practice exercises

1. **Lazy from scratch.** Write `fun <T> myLazy(init: () -> T): ReadOnlyProperty<Any?, T>` with double-checked locking that supports `null` values. Start 10 threads that read it and check the initializer ran exactly once.
2. **SharedPreferences delegates.** Write `boolean(key, default)`, `int(key, default)` and `string(key, default)` delegates as extensions on `SharedPreferences`. Use `property.name` as the default key.
3. **Sealed result pipeline.** Model `sealed interface LoadResult<out T>` with `Loading`, `Success<T>` and `Failure(error: AppError)`, where `AppError` is also sealed. Write `map`, `onSuccess` and `getOrNull`. Explain why `out` lets `Loading` be a `LoadResult<Nothing>` that fits a `LoadResult<User>`.
4. **Sequence vs list.** On 1,000,000 numbers, run `map`, `filter` and `first` as a list and as a sequence. Count how often each lambda runs. Repeat on 10 elements and compare times.
5. **Type-safe DSL.** Build `http { get("/users") { header("Auth", token); query("page", 1) } }` that produces a `Request` data class. Use `@DslMarker` so `get` cannot be nested. Make the builder `inline`, decompile it, and point out what was inlined.

### References

- [Kotlin language documentation](https://kotlinlang.org/docs/home.html)
- [Null safety](https://kotlinlang.org/docs/null-safety.html)
- [Properties](https://kotlinlang.org/docs/properties.html)
- [Inline functions](https://kotlinlang.org/docs/inline-functions.html)
- [Scope functions](https://kotlinlang.org/docs/scope-functions.html)
- [Sealed classes and interfaces](https://kotlinlang.org/docs/sealed-classes.html)
- [Delegated properties](https://kotlinlang.org/docs/delegated-properties.html)
- [Generics: in, out, where](https://kotlinlang.org/docs/generics.html)
- [Sequences](https://kotlinlang.org/docs/sequences.html)
- [Calling Kotlin from Java](https://kotlinlang.org/docs/java-to-kotlin-interop.html)
- [Type-safe builders](https://kotlinlang.org/docs/type-safe-builders.html)
- [What's new in Kotlin 2.2](https://kotlinlang.org/docs/whatsnew22.html)

:::check
Q: A `ViewModel` exposes `val items: List<Item>` that points at a private `MutableList` it keeps changing. Can the UI rely on `items` never changing?
A: No. `List` is read-only, not immutable, so the UI sees every change to the same object. Expose a copy or an immutable list, ideally through a `StateFlow`.
Q: Spot the bug: `data class Key(var id: Int)` is used as a `HashMap` key, then you set `key.id = 2`.
A: The hash code changes, so `map[key]` looks in the wrong bucket and the entry is effectively lost. Keep keys immutable with `val`.
Q: Interview: Explain what `inline fun <reified T> Context.start()` compiles to and why `reified` needs `inline`.
A: The body is copied into each call site, with `T::class.java` replaced by the concrete class, like `SettingsActivity.class`. Without inlining there is one shared body and `T` is erased, so the type would be unknown.
:::
