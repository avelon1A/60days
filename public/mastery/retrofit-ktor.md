## HTTP refresher for interviews

The HTTP basics interviewers expect you to speak clearly before they ask about any client library.

:::tldr
- Safe methods do not change state; idempotent methods can be repeated safely, so only they get automatic retries.
- 401 means "who are you?" and triggers a token refresh; 403 means "no", and refreshing will not help.
- `Cache-Control`, `ETag` and `If-None-Match` let a client skip downloading data it already has.
:::

### Why this matters

You do not need to be a networking expert. But Retrofit, OkHttp and Ktor are all thin layers over HTTP. Interviewers use HTTP questions to check whether you understand what your library does for you.

### Methods, safety and idempotency

A **safe** method does not change server state. An **idempotent** method can be sent many times with the same effect as sending it once. Idempotency tells you which requests are safe to retry automatically.

| Method | Purpose | Safe | Idempotent | Has body |
|---|---|---|---|---|
| GET | Read a resource | Yes | Yes | No |
| HEAD | Like GET, headers only | Yes | Yes | No |
| POST | Create, or run an action | No | No | Yes |
| PUT | Replace a resource fully | No | Yes | Yes |
| PATCH | Partial update | No | Not guaranteed | Yes |
| DELETE | Remove a resource | No | Yes | Usually no |
| OPTIONS | Ask what is allowed | Yes | Yes | No |

> **Interview:** "Is it safe to retry a POST?" Not by default. A retried "create order" could create two orders. Servers solve this with an `Idempotency-Key` header: the client sends a unique key, and the server ignores duplicates with the same key.

### Status codes

- **2xx success.** `200 OK`, `201 Created`, `204 No Content` (no body).
- **3xx redirect.** `301`, `302`, `307`, `308`. OkHttp follows redirects by default. `304 Not Modified` means "use your cached copy".
- **4xx client error.** `400 Bad Request`, `401 Unauthorized`, `403 Forbidden`, `404 Not Found`, `409 Conflict`, `422` (validation failed), `429 Too Many Requests` (often with a `Retry-After` header).
- **5xx server error.** `500`, `502 Bad Gateway`, `503 Service Unavailable`, `504 Gateway Timeout`. Often temporary, so often worth retrying with backoff.

> **Tip:** 401 means "who are you?": you are not logged in or the token expired. 403 means "I know who you are, and the answer is no". A token refresh fixes a 401, never a 403.

### Headers you should know

- `Content-Type` says what the body is, for example `application/json`.
- `Accept` says what the client wants back.
- `Authorization` carries credentials, for example `Bearer <token>`.
- `Accept-Encoding: gzip` asks for compressed responses. OkHttp adds this for you.
- `User-Agent`, `Accept-Language`, and custom headers like `X-Request-Id` for tracing.

### Caching headers

- `Cache-Control: max-age=60` means the response is fresh for 60 seconds.
- `Cache-Control: no-cache` means you may store it, but must check with the server before using it.
- `Cache-Control: no-store` means do not store it at all. Use it for sensitive data.
- `ETag` is a version tag for a resource. The client sends it back in `If-None-Match`. If nothing changed, the server replies `304` with no body.
- `Last-Modified` and `If-Modified-Since` do the same thing with timestamps.

```http
GET /users/42 HTTP/1.1
If-None-Match: "v7"

HTTP/1.1 304 Not Modified
ETag: "v7"
```

The client saved a full download. It reuses the body it already stored.

### HTTPS and TLS at a high level

HTTPS is HTTP inside a TLS connection. During the TLS handshake the server sends its certificate chain. The client checks that the chain leads to a trusted certificate authority (CA) and that the certificate matches the host name. Then both sides agree on keys and encrypt all traffic.

During the same handshake, a step called ALPN lets both sides agree on HTTP/2. HTTP/2 can send many requests at once over one connection.

> **Note:** For apps targeting Android 9 (API 28) or higher, cleartext HTTP is blocked by default. You opt in with a network security config, which you should only do for local development hosts.

:::check
Q: A screen fires `PATCH /profile` and the connection drops before the response. Should your client retry it automatically?
A: Not by default. PATCH is not guaranteed to be idempotent, so a retry could apply the change twice. Retry only if the API documents it as idempotent or supports an idempotency key.
Q: Your request gets a 403. A teammate suggests refreshing the token and retrying. Will it help?
A: No. 403 means the server knows who you are and still refuses. Only a 401 signals a missing or expired credential.
Q: Interview: How does a 304 response save bandwidth?
A: The client sends the stored `ETag` in `If-None-Match`. If the resource did not change, the server answers `304` with no body, and the client reuses its cached copy.
:::

## How Retrofit works

What really happens between calling a method on a Retrofit interface and bytes going over the network.

:::tldr
- `retrofit.create()` returns a dynamic proxy; each method is parsed once into a cached `ServiceMethod`.
- Retrofit builds an OkHttp request; OkHttp does all the real networking.
- Suspend functions use `enqueue()`, so they are main-safe and cancel the HTTP call when the coroutine is cancelled.
:::

### The big picture

Retrofit turns a Kotlin interface into an HTTP client. You describe each endpoint with annotations. Retrofit builds the implementation at runtime and hands the request to OkHttp.

Retrofit 2.11+ and 3.x keep the same `retrofit2` package and the same API, so everything here applies to both.

### Minimal setup

```kotlin
@Serializable
data class UserDto(val id: Long, val name: String, val email: String? = null)

interface UserApi {
    @GET("users/{id}")
    suspend fun getUser(@Path("id") id: Long): UserDto
}

val json = Json { ignoreUnknownKeys = true }

val retrofit = Retrofit.Builder()
    .baseUrl("https://api.example.com/")
    .client(okHttpClient)
    .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
    .build()

val userApi: UserApi = retrofit.create()   // Kotlin extension; or create(UserApi::class.java)
```

### From interface to network call

1. `retrofit.create()` returns a **dynamic proxy** built with `java.lang.reflect.Proxy`. Every call on the interface goes into one `InvocationHandler`.
2. On the first call to a method, Retrofit reads its annotations and parameter types and builds a `ServiceMethod`. It caches it, so the reflection cost is paid once per method.
3. The `ServiceMethod` holds a request factory (how to build URL, headers and body), plus the chosen converter and call adapter.
4. Each call builds an `okhttp3.Request` and wraps it in an `OkHttpCall`. The call adapter decides how to expose it: a `Call<T>`, a suspend result, an RxJava type, and so on.
5. OkHttp runs the request through its interceptor chain and returns a raw response. Retrofit uses the converter to turn the body into your type.

> **Under the hood:** For a `suspend` function, the compiler adds a hidden `Continuation` parameter. Retrofit detects it, calls `enqueue()` on the OkHttp call, and resumes the coroutine from the callback using `suspendCancellableCoroutine`.

### Main-safe by design

Because suspend functions use `enqueue()`, the call runs on OkHttp's own thread pool. Your coroutine just suspends. You can call a Retrofit suspend function from `Dispatchers.Main` without blocking it.

Wrapping it in `withContext(Dispatchers.IO)` is not needed. It only adds a thread hop.

Cancellation also works both ways. If `viewModelScope` is cancelled, Retrofit cancels the OkHttp call, and the socket work stops.

> **Pitfall:** Retrofit checks a method only when it is first called. A typo, like a missing `{id}` placeholder, crashes at runtime, not at compile time. Use `validateEagerly(true)` in debug builds to fail fast at `create()`.

### Base URL rules

These rules cause a surprising number of real bugs.

- The base URL **must end with** `/`. Otherwise `baseUrl()` throws `IllegalArgumentException`.
- A relative path like `"users"` is added to the base URL's path.
- A path starting with `/`, like `"/users"`, replaces the whole path of the base URL.
- A full URL in the annotation or in `@Url` ignores the base URL entirely.

| Base URL | Annotation path | Final URL |
|---|---|---|
| `https://api.example.com/v2/` | `users` | `https://api.example.com/v2/users` |
| `https://api.example.com/v2/` | `/users` | `https://api.example.com/users` |
| `https://api.example.com/v2/` | `https://cdn.example.com/a` | `https://cdn.example.com/a` |

> **Tip:** Keep the version in the base URL (`.../v2/`) and never start annotation paths with `/`. Then the version can never be dropped by accident.

:::deeper Why a proxy and not code generation?
Retrofit was built before KSP existed. A dynamic proxy needs no build step and works with any interface. The cost is a bit of reflection on the first call of each method, which is then cached.

The trade-off shows up with R8. Retrofit's library ships its own keep rules, but full R8 mode can still strip generic type information from your return types. Recent Retrofit versions include rules for common cases, so keep Retrofit up to date and test release builds.
:::

:::check
Q: With base URL `https://api.example.com/v2/`, where does `@GET("/users")` go?
A: To `https://api.example.com/users`. A leading `/` replaces the base path, so `v2` is dropped.
Q: A teammate wraps every Retrofit suspend call in `withContext(Dispatchers.IO)`. Is it needed?
A: No. Retrofit's suspend support uses `enqueue()`, so the work already runs on OkHttp's threads. The wrapper only adds a thread switch.
Q: Interview: How does Retrofit turn an interface into working code?
A: `create()` returns a dynamic proxy. On first call, each method is parsed into a cached `ServiceMethod` with a request factory, converter and call adapter. Each call builds an OkHttp request in an `OkHttpCall`, and the adapter exposes it as `Call<T>`, a suspend result, or another type.
:::

## Retrofit annotations

The annotations that describe URLs, queries, bodies, headers, forms, uploads and downloads.

:::tldr
- `@Path`, `@Query`, `@QueryMap` and `@Url` shape the URL; null `@Query` values are skipped.
- `@Body` uses the converter; `@FormUrlEncoded` with `@Field` and `@Multipart` with `@Part` cover forms and uploads.
- `@Streaming` returns the body as a stream instead of loading it all into memory.
:::

### HTTP method and URL

```kotlin
interface ArticleApi {
    @GET("articles")
    suspend fun list(
        @Query("page") page: Int,
        @Query("tag") tag: String? = null,       // null values are skipped
    ): List<ArticleDto>

    @GET("articles/{id}")
    suspend fun get(@Path("id") id: String): ArticleDto

    @GET("search")
    suspend fun search(@QueryMap filters: Map<String, String>): SearchDto

    @GET
    suspend fun byUrl(@Url url: String): ArticleDto   // full or relative URL at runtime
}
```

- `@Path` fills a `{placeholder}`. Values are URL-encoded, so a `/` inside the value becomes `%2F`, unless you set `encoded = true`.
- `@Query` adds `?key=value`. A `List` parameter repeats the key: `?tag=a&tag=b`.
- `@QueryMap` adds many query parameters at once.
- `@Url` is handy for "next page" links that the server returns as full URLs.
- Other method annotations: `@POST`, `@PUT`, `@PATCH`, `@DELETE`, `@HEAD`, `@OPTIONS`, and `@HTTP` for custom cases, such as a DELETE with a body.

### Body and headers

```kotlin
interface OrderApi {
    @POST("orders")
    suspend fun create(@Body request: CreateOrderRequest): OrderDto

    @Headers("Cache-Control: no-cache")             // static header
    @GET("orders/{id}")
    suspend fun get(
        @Path("id") id: String,
        @Header("X-Request-Id") requestId: String,   // dynamic header
    ): OrderDto

    @GET("orders")
    suspend fun list(@HeaderMap headers: Map<String, String>): List<OrderDto>
}
```

`@Body` uses the converter to serialize the object. Without a converter, `@Body` only accepts an OkHttp `RequestBody`.

> **Tip:** Put headers that every request needs (auth, user agent, locale) in an OkHttp interceptor, not on each method. Keep `@Header` for values that really change per call.

### Forms

```kotlin
interface AuthApi {
    @FormUrlEncoded
    @POST("oauth/token")
    suspend fun token(
        @Field("grant_type") grantType: String,
        @Field("refresh_token") refreshToken: String,
    ): TokenDto
}
```

`@FormUrlEncoded` sends `application/x-www-form-urlencoded`, built from `@Field` or `@FieldMap`. OAuth token endpoints often expect this format, not JSON.

### Multipart uploads

```kotlin
interface UploadApi {
    @Multipart
    @POST("photos")
    suspend fun upload(
        @Part("caption") caption: RequestBody,
        @Part photo: MultipartBody.Part,
    ): PhotoDto
}

val file = File(context.cacheDir, "photo.jpg")
val part = MultipartBody.Part.createFormData(
    "photo", file.name, file.asRequestBody("image/jpeg".toMediaType())
)
val caption = "Sunset".toRequestBody("text/plain".toMediaType())
```

`@Multipart` sends `multipart/form-data`, built from `@Part` or `@PartMap`. Each part has its own headers and content type. Use it for file uploads.

### Large downloads with @Streaming

```kotlin
@Streaming
@GET
suspend fun download(@Url url: String): ResponseBody

suspend fun saveTo(file: File, url: String) = withContext(Dispatchers.IO) {
    api.download(url).use { body ->
        body.byteStream().use { input ->
            file.outputStream().use { output -> input.copyTo(output) }
        }
    }
}
```

Without `@Streaming`, Retrofit reads the whole body into memory before returning. With it, you get the stream as soon as the headers arrive.

Reading that stream is blocking I/O. So this is the one case where you do need `Dispatchers.IO`. Always close the body, which `use { }` does for you.

> **Pitfall:** A `BODY`-level logging interceptor reads the whole response to log it. That defeats `@Streaming` and can run a large download out of memory.

### Picking the right annotation

- Value goes inside the path, like an id: `@Path`.
- Optional filter or paging value: `@Query`, nullable so it can be left out.
- Server gives you a ready-made link: `@Url`.
- JSON object to send: `@Body`.
- Key-value form expected by the server, common for OAuth: `@FormUrlEncoded` with `@Field`.
- A file plus some fields: `@Multipart` with `@Part`.

:::check
Q: You call `api.list(page = 1, tag = null)`. What URL is sent?
A: `articles?page=1`. Retrofit skips `@Query` parameters whose value is null.
Q: Spot the bug: a `@Streaming` download is read with `body.byteStream()` directly inside `viewModelScope.launch { }` on the main dispatcher.
A: The stream read is blocking I/O, so it blocks the main thread. Read it inside `withContext(Dispatchers.IO)` and close the body with `use`.
Q: Interview: Where would you add an `Authorization` header: `@Header` on each method, or somewhere else?
A: In an OkHttp interceptor, so every request gets it in one place and the token can change at runtime. `@Header` is for values that really differ per call.
:::

## Return types and call adapters

Choosing between `T`, `Response<T>` and `Call<T>`, and what call adapters add on top.

:::tldr
- `suspend fun x(): T` throws `HttpException` on non-2xx; `Response<T>` returns normally and exposes code, headers and error body.
- Both throw `IOException` on network failures, so you always need error handling.
- Use `Unit` for empty bodies; call adapters change what methods can return.
:::

### The three common shapes

| Declared type | Non-2xx response | Network failure | Gives headers and code |
|---|---|---|---|
| `suspend fun x(): T` | Throws `HttpException` | Throws `IOException` | No |
| `suspend fun x(): Response<T>` | Returns, `isSuccessful` is false | Throws `IOException` | Yes |
| `fun x(): Call<T>` | You inspect the `Response` | `onFailure`, or thrown by `execute()` | Yes |

### Plain T

```kotlin
@GET("users/{id}")
suspend fun getUser(@Path("id") id: Long): UserDto
```

This is the simplest and most common shape. Success gives you the parsed body. Any non-2xx status throws `retrofit2.HttpException`, which carries `code()` and `response()`.

The cost: on success you cannot read headers. If you need an `ETag` or a pagination `Link` header, this shape is not enough.

### Response<T>

```kotlin
@GET("users/{id}")
suspend fun getUserResponse(@Path("id") id: Long): Response<UserDto>

val response = api.getUserResponse(42)
if (response.isSuccessful) {
    val user = response.body()                     // nullable
    val etag = response.headers()["ETag"]
} else {
    val code = response.code()
    val raw = response.errorBody()?.string()       // read once only
}
```

`Response<T>` gives full control. You can branch on the status code and read headers on success.

> **Pitfall:** `Response<T>` does not protect you from `IOException`. No internet, DNS failure, and timeouts still throw. You need a try/catch either way.

### Call<T>

`Call<T>` is the original, pre-coroutine shape. `execute()` blocks the current thread. `enqueue(callback)` runs async and calls you back. A `Call` can be run only once; use `clone()` to repeat it.

You still meet `Call<T>` in older code and in Java modules. In new Kotlin code, prefer suspend functions.

### Empty bodies

For `204 No Content`, or endpoints where you do not care about the body, declare `Unit` or `Response<Unit>`. Retrofit has built-in support and will not try to parse an empty body.

```kotlin
@DELETE("orders/{id}")
suspend fun delete(@Path("id") id: String): Response<Unit>
```

### Which one to pick

Start with plain `T` and one central error mapper. It keeps API interfaces short and repository code clean.

Switch a single method to `Response<T>` when it needs headers or special status handling. Mixing both in one interface is normal. Reach for `Call<T>` only for Java callers or legacy code.

### Call adapters

A `CallAdapter.Factory` changes what a method may return. Suspend support is built in, so most Kotlin projects need no adapter at all. Older code uses `RxJava3CallAdapterFactory` to return `Single<T>` or `Observable<T>`.

Some teams write a custom call adapter so methods return a sealed result type directly, such as `suspend fun getUser(): NetworkResult<UserDto>`. Libraries like Sandwich and EitherNet do this.

It removes try/catch from every repository. But it is extra code to own and to explain to new team members. A small `safeApiCall` helper (next lessons) is usually enough.

> **Under the hood:** Retrofit attaches an `Invocation` tag to every OkHttp request. An interceptor can read `request.tag(Invocation::class.java)` to see which interface method produced the request. This is how you build annotations like `@SkipAuth`.

```kotlin
@Target(AnnotationTarget.FUNCTION)
annotation class SkipAuth

// inside an interceptor
val skip = chain.request().tag(Invocation::class.java)
    ?.method()?.isAnnotationPresent(SkipAuth::class.java) == true
```

:::check
Q: An endpoint returns `204 No Content` and you declared `suspend fun delete(): DeleteDto`. What is likely to go wrong?
A: There is no body to parse into `DeleteDto`, so the call fails or gives a null where Kotlin expects non-null. Declare `Unit` or `Response<Unit>` instead.
Q: You switched from `suspend fun x(): T` to `Response<T>` and removed the try/catch. What did you miss?
A: Network failures like `UnknownHostException` and timeouts still throw `IOException`. `Response<T>` only stops non-2xx statuses from throwing.
Q: Interview: When would you choose `Response<T>` over plain `T`?
A: When you need headers on success (an `ETag`, a pagination link) or want to branch on specific status codes without exceptions. For simple calls, plain `T` with central error mapping is cleaner.
:::

## Converters and serialization

How JSON turns into Kotlin objects, and why the choice of library affects crashes in production.

:::tldr
- A `Converter.Factory` maps bodies to objects and back; Retrofit tries converters in the order you add them.
- Prefer kotlinx.serialization with `ignoreUnknownKeys = true`; Moshi with codegen is a fine Android-only option.
- Gson ignores Kotlin null safety and default values, which causes crashes far from the cause.
:::

### What a converter does

Retrofit itself knows nothing about JSON. A `Converter.Factory` turns response bodies into objects, and objects into request bodies.

Retrofit asks each factory in the order you added them. The first one that says "I can handle this type" wins. If you also use a scalars converter (for plain `String` bodies), add it before the JSON converter.

### kotlinx.serialization

```kotlin
// plugin: org.jetbrains.kotlin.plugin.serialization
// dependency: com.squareup.retrofit2:converter-kotlinx-serialization

@Serializable
data class ArticleDto(
    val id: String,
    val title: String,
    @SerialName("published_at") val publishedAt: String,
    val tags: List<String> = emptyList(),
)

val json = Json {
    ignoreUnknownKeys = true   // new server fields will not crash old app versions
    coerceInputValues = true   // null or unknown enum for a field with a default uses the default
    explicitNulls = false      // do not send nulls; missing nullable fields become null
}
```

The compiler plugin generates a serializer for each `@Serializable` class at build time. There is no reflection at runtime.

The converter lives in the official Retrofit repository since Retrofit 2.11. Older projects used Jake Wharton's artifact, which has the same `asConverterFactory` function.

> **Pitfall:** By default `Json` throws on unknown keys. If you forget `ignoreUnknownKeys = true`, the server adding one field can crash every installed version of your app.

### Comparing the three main converters

| Aspect | kotlinx.serialization | Moshi | Gson |
|---|---|---|---|
| How it works | Compiler plugin, generated serializers | Codegen (KSP) or reflection | Reflection |
| Kotlin null safety | Respected | Respected with Kotlin support | Ignored |
| Default values | Respected | Respected | Ignored |
| Multiplatform | Yes | No | No |
| Formats | JSON, Protobuf, CBOR and more | JSON | JSON |
| R8 | Few rules, no reflection | Few rules with codegen | Needs keep rules |
| Status | Active, Kotlin-first | Active | Maintenance mode |

### Why Gson is risky in Kotlin

Gson creates objects without calling your constructor. So Kotlin never gets a chance to check nulls or apply defaults.

```kotlin
data class User(val name: String, val tags: List<String> = emptyList())

// JSON: {"name": null}
val user = gson.fromJson(raw, User::class.java)
user.name.length   // NullPointerException here, far from the parsing code
user.tags.size     // also NPE: the default value was never applied
```

The crash happens later, when you read the field, often in UI code. That makes it hard to trace back to the JSON.

> **Interview:** "Why move from Gson?" Gson bypasses Kotlin constructors, so non-null fields can hold null and defaults are skipped. kotlinx.serialization respects both, needs no reflection, and also works in Kotlin Multiplatform.

### Designing DTOs defensively

Servers change. Old app versions live for years. A few rules keep parsing safe:

- Give optional fields a default or make them nullable.
- Use `@SerialName` to keep Kotlin names clean when JSON uses `snake_case`.
- Keep dates as `String` or use a custom serializer, then convert in the mapper.
- For enums, add a fallback value, and use `coerceInputValues` so unknown values become the default.

### DTOs are not domain models

Keep `@Serializable` classes in the data layer as **DTOs** (data transfer objects). They mirror the server's JSON, including odd names and nullable fields.

Map them to clean domain models before they leave the repository. Then a server rename changes one mapper, not your whole UI.

:::check
Q: The server adds a new field `"badge"` to the user JSON. Your `Json` has default settings. What happens in the installed app?
A: Parsing throws a `SerializationException` for the unknown key, so the screen fails. Set `ignoreUnknownKeys = true` to avoid this.
Q: With Gson, `data class User(val name: String)` parses `{"name": null}`. When does it crash?
A: Not during parsing. It crashes later with a `NullPointerException` when code reads `name`, because Gson skipped the constructor's null check.
Q: Interview: Why keep DTOs separate from domain models?
A: DTOs mirror the server's contract, with its names and nullability. Domain models are what the app wants. A mapper between them means server changes touch one place, and the UI never depends on the wire format.
:::

## Error handling

How to turn every kind of network failure into a small, typed error the UI can handle.

:::tldr
- Failures fall into four groups: no network (`IOException`), server said no (`HttpException`), bad body (`SerializationException`), and cancellation.
- Map them at the data layer into a sealed `DataError`, and return a sealed result to the ViewModel.
- Always rethrow `CancellationException`; never wrap network calls in a bare `runCatching`.
:::

### What can go wrong

- **No connection, DNS failure, timeout, connection reset.** These are `IOException` subclasses: `UnknownHostException`, `SocketTimeoutException`, `ConnectException`, and others.
- **Server said no.** A non-2xx status. With `suspend fun x(): T`, Retrofit throws `retrofit2.HttpException`.
- **Body did not match your model.** kotlinx.serialization throws `SerializationException`. This is a bug or a contract change, not a user problem.
- **Cancellation.** A `CancellationException` when the scope is cancelled. It is normal and must be rethrown.

### Map to a sealed result

The ViewModel should not know what `HttpException` is. Convert errors at the data layer boundary into a small, closed set.

```kotlin
sealed interface DataError {
    data object NoInternet : DataError
    data object Timeout : DataError
    data object Unauthorized : DataError
    data object NotFound : DataError
    data class Server(val code: Int) : DataError
    data class Validation(val message: String) : DataError
    data object Serialization : DataError
    data class Unknown(val cause: Throwable) : DataError
}

sealed interface Outcome<out T> {
    data class Success<T>(val data: T) : Outcome<T>
    data class Failure(val error: DataError) : Outcome<Nothing>
}
```

### A safeApiCall helper

```kotlin
suspend fun <T> safeApiCall(block: suspend () -> T): Outcome<T> = try {
    Outcome.Success(block())
} catch (e: CancellationException) {
    throw e                                        // never swallow cancellation
} catch (e: HttpException) {
    Outcome.Failure(e.toDataError())
} catch (e: InterruptedIOException) {              // socket and call timeouts
    Outcome.Failure(DataError.Timeout)
} catch (e: IOException) {
    Outcome.Failure(DataError.NoInternet)
} catch (e: SerializationException) {
    Outcome.Failure(DataError.Serialization)
}
```

Order matters. `SocketTimeoutException` and OkHttp's call timeout are both `InterruptedIOException`, which is an `IOException`. So the timeout branch must come first.

```kotlin
fun HttpException.toDataError(): DataError = when (code()) {
    401 -> DataError.Unauthorized
    404 -> DataError.NotFound
    422 -> DataError.Validation(parseErrorMessage(this) ?: "Invalid input")
    in 500..599 -> DataError.Server(code())
    else -> DataError.Unknown(this)
}
```

### Parsing the error body

Servers often send a JSON error body with a message. Read it once and decode it.

```kotlin
@Serializable
data class ApiErrorDto(val message: String? = null, val code: String? = null)

fun parseErrorMessage(e: HttpException): String? = try {
    val raw = e.response()?.errorBody()?.string() ?: return null
    json.decodeFromString<ApiErrorDto>(raw).message
} catch (e: Exception) {
    null                                           // not JSON, or unexpected shape
}
```

This function is not `suspend`, so catching `Exception` here cannot swallow coroutine cancellation.

> **Pitfall:** `errorBody().string()` consumes the stream. A second call gives an empty string. Read it once and keep the result.

> **Pitfall:** `runCatching` around a suspend call also catches `CancellationException`. A cancelled screen then runs its error branch and the coroutine keeps going. Catch specific types, or rethrow cancellation.

### Why not throw to the UI

- The UI would need to know library types, which couples it to Retrofit or Ktor.
- An uncaught exception in `viewModelScope` crashes the app.
- A sealed error forces an exhaustive `when`, which maps cleanly to messages and retry buttons.
- Tests become simple: a fake repository returns `Outcome.Failure(DataError.NoInternet)`.

```kotlin
fun DataError.toMessage(): Int = when (this) {
    DataError.NoInternet -> R.string.error_offline
    DataError.Timeout -> R.string.error_slow
    DataError.Unauthorized -> R.string.error_login_again
    else -> R.string.error_generic
}
```

:::check
Q: Spot the bug: the `catch (e: IOException)` branch comes before `catch (e: InterruptedIOException)`.
A: Timeouts are `IOException` subclasses, so the first branch catches them and they are reported as "no internet". Catch the more specific type first.
Q: A user leaves the screen during a request, and your log shows "Unknown error" right after. What is the likely cause?
A: Something caught `CancellationException`, often `runCatching` or `catch (e: Exception)` in suspend code, and treated cancellation as a failure. Rethrow it.
Q: Interview: How do you handle errors from the network layer?
A: Catch at the data layer, map to a sealed `DataError` (no internet, timeout, unauthorized, not found, server, validation, serialization, unknown), rethrow cancellation, and return a sealed `Outcome`. The ViewModel maps errors to UI messages and never sees `HttpException` or `IOException`.
:::

## OkHttp at a working level

The engine under Retrofit: one shared client, timeouts, interceptors, logging and retries.

:::tldr
- Use one `OkHttpClient` for the app; derive variants with `newBuilder()` so they share the connection pool and threads.
- Connect, read and write timeouts default to 10 seconds; `callTimeout` caps the whole call and is off by default.
- Application interceptors run once per call; network interceptors run once per network request and see the real wire traffic.
:::

### One client for the whole app

Retrofit does not do networking itself. OkHttp does: connections, TLS, HTTP/2, redirects, retries, caching and gzip. Ktor's OkHttp engine uses it too.

```kotlin
val okHttpClient = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(20, TimeUnit.SECONDS)
    .callTimeout(30, TimeUnit.SECONDS)
    .cache(Cache(File(context.cacheDir, "http_cache"), 10L * 1024 * 1024))
    .addInterceptor(authHeaderInterceptor)
    .addInterceptor(loggingInterceptor)
    .authenticator(tokenAuthenticator)
    .build()
```

Each `OkHttpClient` owns a **connection pool** and a **dispatcher** (thread pool). Reusing one client reuses TCP and TLS connections, which saves a full handshake per request. A client per request throws that away and wastes threads and memory.

If one API needs a different setting, derive a client. It shares the pool and dispatcher.

```kotlin
val uploadClient = okHttpClient.newBuilder()
    .writeTimeout(2, TimeUnit.MINUTES)
    .build()
```

### Timeouts

| Timeout | Covers | Default |
|---|---|---|
| `connectTimeout` | Opening the TCP and TLS connection | 10 seconds |
| `readTimeout` | Max gap between bytes while reading | 10 seconds |
| `writeTimeout` | Max gap between bytes while writing | 10 seconds |
| `callTimeout` | The whole call, including redirects and retries | None |

> **Tip:** `readTimeout` is per gap, not total. A server that sends one byte every 9 seconds never trips it. Use `callTimeout` for a hard limit on the whole request.

### Interceptors

An interceptor sees the request on the way out and the response on the way back. It can change both, or return its own response without calling the network.

```kotlin
class AuthHeaderInterceptor(private val tokens: TokenStore) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val token = tokens.accessToken()
        val request = chain.request().newBuilder()
            .apply { if (token != null) header("Authorization", "Bearer $token") }
            .header("Accept-Language", Locale.getDefault().toLanguageTag())
            .build()
        return chain.proceed(request)
    }
}
```

There are two kinds.

| | Application interceptor | Network interceptor |
|---|---|---|
| Added with | `addInterceptor()` | `addNetworkInterceptor()` |
| Runs | Once per call | Once per network request, so again for redirects and retries |
| Cache hit | Still runs | Skipped, no network used |
| Sees | The request as your code built it | The real wire request, with `Accept-Encoding: gzip` |
| Can short-circuit | Yes | No, must call `proceed()` exactly once |
| Typical use | Auth header, logging, offline cache rules, fakes | Inspect real traffic, rewrite cache headers |

> **Interview:** "Auth header: application or network interceptor?" Application. It runs once per call, sees your logical request, and needs no wire-level detail.

### Logging

```kotlin
val loggingInterceptor = HttpLoggingInterceptor().apply {
    level = if (BuildConfig.DEBUG) HttpLoggingInterceptor.Level.BODY
            else HttpLoggingInterceptor.Level.NONE
    redactHeader("Authorization")
    redactHeader("Cookie")
}
```

Levels are `NONE`, `BASIC` (request line and response code), `HEADERS`, and `BODY`. `BODY` buffers the whole body, which breaks large downloads and leaks personal data into Logcat. Keep it debug-only.

### Retries

OkHttp already retries some connection failures silently (`retryOnConnectionFailure` is true by default). It does not retry 5xx responses. If you add your own retry, limit it to idempotent methods.

```kotlin
class RetryInterceptor(private val maxRetries: Int = 2) : Interceptor {
    private val idempotent = setOf("GET", "HEAD", "PUT", "DELETE", "OPTIONS")
    private val retryable = setOf(502, 503, 504)

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        var response = chain.proceed(request)
        var attempt = 0
        while (request.method in idempotent && response.code in retryable && attempt < maxRetries) {
            response.close()                          // must close before retrying
            Thread.sleep(500L * (1 shl attempt))      // simple exponential backoff
            attempt++
            response = chain.proceed(request)
        }
        return response
    }
}
```

> **Note:** `Thread.sleep` is acceptable here because interceptors run on OkHttp's background threads. Many teams prefer retrying in the repository with coroutines and `delay`, which is easier to cancel and test.

:::deeper Dispatcher limits and EventListener
OkHttp's `Dispatcher` limits concurrent async calls: 64 in total and 5 per host by default. Retrofit suspend calls use `enqueue()`, so they count. Fire 20 requests at one host and only 5 run at once; the rest wait in a queue.

You can raise `maxRequestsPerHost`. Often the better fix is fewer, larger requests.

To measure where time goes, attach an `EventListener`. It gets callbacks for DNS start and end, connect, TLS handshake, request sent, and response headers received. That shows whether a slow call is slow DNS, a new handshake, or the server.
:::

:::check
Q: A server streams a response, sending a few bytes every 8 seconds, for 5 minutes. Which default timeout fires?
A: None. `readTimeout` (10 seconds) only measures the gap between bytes, and `callTimeout` is off by default. Set `callTimeout` for a total limit.
Q: You add a logging interceptor with `addNetworkInterceptor`, and a cached response appears. Does it get logged?
A: No. Network interceptors are skipped when the cache answers. An application interceptor would log it.
Q: Interview: Why should `OkHttpClient` be a singleton?
A: Each client owns a connection pool and a thread pool. Sharing one reuses connections, avoiding repeated TCP and TLS handshakes, and saves memory and threads. For a variant, `newBuilder()` shares the pool and dispatcher.
:::

## Auth and token refresh

Refreshing an expired access token exactly once, even when many requests fail together.

:::tldr
- OkHttp calls an `Authenticator` on a 401; return a new request to retry, or `null` to give up.
- Serialize refreshes with a lock, and inside it compare the failed token with the stored one.
- Make the refresh call on a separate client without the authenticator, to avoid recursion.
:::

### The flow

Most apps use a short-lived **access token** and a long-lived **refresh token**. When the access token expires, the server returns 401. The client should refresh once, retry the original request, and log the user out only if the refresh fails.

### The Authenticator

OkHttp calls an `Authenticator` when a response is 401. You return a new request to retry, or `null` to give up and let the 401 through.

```kotlin
class TokenAuthenticator(private val refresher: TokenRefresher) : Authenticator {

    override fun authenticate(route: Route?, response: Response): Request? {
        if (responseCount(response) >= 2) return null           // stop loops
        val failed = response.request.header("Authorization")?.removePrefix("Bearer ")
        val newToken = runBlocking { refresher.refreshIfNeeded(failed) } ?: return null
        return response.request.newBuilder()
            .header("Authorization", "Bearer $newToken")
            .build()
    }

    private fun responseCount(response: Response): Int =
        generateSequence(response) { it.priorResponse }.count()
}
```

`priorResponse` links each retry to the response that caused it. Counting them stops an endless loop if the new token is also rejected.

> **Note:** `runBlocking` is acceptable here because `authenticate` runs on an OkHttp worker thread, never the main thread. Give the refresh client a short timeout.

### The parallel refresh problem

Imagine a screen that loads 5 things at once. The token has expired, so all 5 get 401 at nearly the same time. A naive authenticator calls the refresh endpoint 5 times.

Many servers **rotate** refresh tokens: each refresh invalidates the old refresh token. So the first refresh works, the other 4 fail, and the user is logged out for no reason.

The fix has two parts:

1. **Serialize the refresh.** Only one refresh may run at a time. In coroutine code, use a `Mutex`.
2. **Check before refreshing.** Inside the lock, compare the token that failed with the token stored now. If they differ, someone already refreshed. Just retry with the stored token.

```kotlin
class TokenRefresher(private val tokens: TokenStore, private val api: RefreshApi) {
    private val mutex = Mutex()

    suspend fun refreshIfNeeded(failedToken: String?): String? = mutex.withLock {
        val current = tokens.accessToken()
        if (current != null && current != failedToken) return current   // already refreshed
        val refresh = tokens.refreshToken() ?: return null
        when (val result = safeApiCall { api.refresh(RefreshRequest(refresh)) }) {
            is Outcome.Success -> result.data.also { tokens.save(it) }.accessToken
            is Outcome.Failure -> { tokens.clear(); null }               // log out
        }
    }
}
```

Walk through the 5 requests. The first gets the lock and refreshes. The other 4 wait. When each gets the lock, the stored token no longer equals its failed token, so it returns the new token without calling the server.

> **Pitfall:** Do not make the refresh call with the same `OkHttpClient` and Authenticator. If the refresh endpoint returns 401, you get recursion. Build `RefreshApi` on `okHttpClient.newBuilder()` with no authenticator.

### Proactive vs reactive refresh

- **Reactive:** the `Authenticator` waits for a real 401, then refreshes.
- **Proactive:** an interceptor checks the token's expiry time before sending, and refreshes early.

Many apps use both. Refresh early if the token is about to expire, and keep the Authenticator as the safety net for clock skew or server-side revocation.

> **Interview:** "Interceptor or Authenticator for refresh?" The Authenticator is built for reacting to 401 and retrying. An interceptor suits proactive refresh. Use the interceptor only to add the header and maybe refresh early; let the Authenticator handle the 401.

:::deeper Hosts, logout and storage
- Only attach tokens to your own hosts. If one client also calls a CDN or a third-party API, check `request.url.host` in the interceptor.
- On logout, clear tokens first, then cancel in-flight work. Otherwise a late refresh may save tokens again.
- Jetpack's `EncryptedSharedPreferences` is deprecated. Many teams now keep tokens in DataStore, encrypted with an Android Keystore key (for example via Tink).
:::

:::check
Q: Five parallel calls get 401 and your authenticator has no lock. The server rotates refresh tokens. What does the user see?
A: Likely a logout. The first refresh rotates the refresh token, so the other four refreshes send an invalid token and fail.
Q: Spot the bug: `RefreshApi` is created from the same Retrofit instance as every other API.
A: The refresh call goes through the same Authenticator. A 401 from the refresh endpoint triggers another refresh, causing recursion or a deadlock on the lock. Use a separate client without the authenticator.
Q: Interview: How do you refresh an expired token in OkHttp?
A: An `Authenticator` reacts to 401. It refreshes once under a `Mutex`, comparing the failed token with the stored one so parallel 401s share one refresh, saves the new tokens, and returns the request with the new header. It returns `null` to give up and uses `priorResponse` to stop loops.
:::

## Caching and certificate pinning

Using OkHttp's HTTP cache well, and pinning certificates without bricking your app.

:::tldr
- `Cache(dir, size)` gives OkHttp a disk cache that follows the server's `Cache-Control` and `ETag` headers.
- For offline reads, force `onlyIfCached` with `maxStale`; for real offline-first, use Room as the source of truth.
- Certificate pinning trusts only specific public keys; always ship a backup pin and a rotation plan.
:::

### HTTP cache

OkHttp has a real disk cache that follows HTTP caching rules. You only give it a directory and a size.

```kotlin
val cache = Cache(File(context.cacheDir, "http_cache"), 20L * 1024 * 1024) // 20 MB
val client = OkHttpClient.Builder().cache(cache).build()
```

When the server sends good `Cache-Control` and `ETag` headers, OkHttp handles the rest:

- A fresh cached response is returned with no network at all.
- A stale one is revalidated with `If-None-Match`. A `304` reuses the cached body.
- `no-store` responses are never written.

You can check where a response came from:

- `response.cacheResponse` is non-null if the cache was used.
- `response.networkResponse` is non-null if the network was used.
- Both are non-null for a conditional request that got a `304`.

> **Note:** OkHttp caches only GET responses. POST results are never cached.

The cache is keyed by URL. Two requests that differ only in headers share one entry, unless the server sends a `Vary` header.

> **Tip:** On logout, call `cache.evictAll()`. Otherwise the next user on the same device could be served the previous user's cached responses.

### Offline reads

To show cached data when offline, an application interceptor can force the cache.

```kotlin
class OfflineCacheInterceptor(private val isOnline: () -> Boolean) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        var request = chain.request()
        if (!isOnline() && request.method == "GET") {
            request = request.newBuilder()
                .cacheControl(
                    CacheControl.Builder().onlyIfCached().maxStale(7, TimeUnit.DAYS).build()
                )
                .build()
        }
        return chain.proceed(request)
    }
}
```

If nothing is cached, OkHttp does not touch the network. It returns a synthetic `504 Unsatisfiable Request`.

Some apps also use a network interceptor to rewrite `Cache-Control` on responses when the server sends no caching headers. It works, but you are overriding the server's intent. Prefer fixing the headers on the server.

> **Tip:** The HTTP cache is not an offline-first strategy. For real offline support, store data in Room and make the database the single source of truth. The HTTP cache is a cheap bonus for read-only data such as config.

### Certificate pinning

Normal TLS trusts any certificate signed by any CA the device trusts. **Pinning** adds a rule: for this host, accept the connection only if the certificate chain contains a public key with this hash.

It protects against a compromised or rogue CA, and makes casual traffic interception harder.

```kotlin
val pinner = CertificatePinner.Builder()
    .add("api.example.com", "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
    .add("api.example.com", "sha256/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=") // backup
    .build()

val client = OkHttpClient.Builder().certificatePinner(pinner).build()
```

- Always pin at least one **backup** key. If the server rotates its key and you pinned only one, every installed app stops connecting until users update.
- Pinning can also be declared in the Android **network security config** XML with a `pin-set`, which supports an expiration date. After it expires, pinning is skipped instead of failing.
- Pinning is a trade-off. Many teams pin only for high-risk apps, like banking.

> **Pitfall:** A pinning mistake can break every installed version of your app at once, with no server-side fix. Agree on key rotation with the backend team before you ship pins.

:::deeper Pin what, exactly?
You pin a hash of the certificate's public key (SPKI), not the whole certificate. A server can renew its certificate with the same key and the pin still matches.

You can pin the leaf, an intermediate, or the root CA key. Pinning an intermediate is a common middle ground: it survives leaf renewals but still rejects certificates from other CAs.
:::

:::check
Q: The app is offline, your interceptor adds `onlyIfCached`, and the URL was never fetched before. What does the caller get?
A: A synthetic `504 Unsatisfiable Request` from OkHttp, with no network attempt. With a suspend `T` return, Retrofit turns it into an `HttpException`.
Q: You pin only the current leaf key. The backend renews its certificate with a new key pair. What happens?
A: Every installed app fails the TLS pin check and cannot reach the API until users install an update with the new pin. Always ship a backup pin.
Q: Interview: How does OkHttp's cache work, and how would you show data offline?
A: Give OkHttp a `Cache`. It follows `Cache-Control`, `ETag` and `Last-Modified`, serves fresh responses from disk, and revalidates stale ones. For offline, force `onlyIfCached` with `maxStale`. For real offline-first, store data in Room as the source of truth.
:::

## Ktor Client basics

Creating a Ktor `HttpClient`, choosing engines, and making requests with the Kotlin DSL.

:::tldr
- Ktor separates the API from the engine: OkHttp on Android, Darwin on iOS, CIO for pure Kotlin.
- `HttpClient(engine) { install(...) }` configures everything; create one client and share it.
- Requests are plain suspend calls like `client.get("articles").body<T>()`.
:::

### What Ktor Client is

Ktor is JetBrains' HTTP framework, and Ktor Client is its client half. It is built on coroutines from the start, uses a Kotlin DSL instead of annotations, and runs on Android, JVM, iOS, desktop and web. That makes it the default choice for Kotlin Multiplatform (KMP).

This lesson targets Ktor 3.x.

### Engines

Ktor separates the API you call from the **engine** that does the actual I/O. You add one engine per platform.

| Engine | Platforms | Notes |
|---|---|---|
| OkHttp | Android, JVM | HTTP/2, reuses OkHttp features, good default on Android |
| Android | Android | Based on HttpURLConnection, fewer features |
| CIO | JVM, Android, Native | Pure Kotlin coroutines, HTTP/1.x only |
| Darwin | iOS, macOS | Uses NSURLSession, the right choice for iOS |
| Js | Browser, Node | Uses fetch |

In KMP, `commonMain` depends on `ktor-client-core`. `androidMain` adds `ktor-client-okhttp`, and `iosMain` adds `ktor-client-darwin`. If you call `HttpClient()` with no engine, Ktor uses the engine it finds in your dependencies.

### Creating a client

```kotlin
val client = HttpClient(OkHttp) {
    expectSuccess = true                       // throw on non-2xx (next lesson)
    install(ContentNegotiation) {
        json(Json { ignoreUnknownKeys = true; explicitNulls = false })
    }
    install(HttpTimeout) {
        connectTimeoutMillis = 10_000
        socketTimeoutMillis = 20_000
        requestTimeoutMillis = 30_000
    }
    defaultRequest {
        url("https://api.example.com/v1/")
        contentType(ContentType.Application.Json)
    }
    engine { preconfigured = sharedOkHttpClient }  // reuse the app's OkHttpClient
}
```

- `install(...)` adds a **plugin**. Almost every feature is a plugin.
- `defaultRequest { }` sets the base URL and headers for every request. Keep the trailing `/`, as in Retrofit.
- `engine { }` configures the engine. With OkHttp, `preconfigured` lets Ktor reuse your existing `OkHttpClient`: its connection pool, cache, certificate pinner and interceptors.

> **Tip:** Like `OkHttpClient`, an `HttpClient` is expensive. Create one per app (or per backend) and share it. Call `client.close()` only when you are truly done with it.

### Making requests

```kotlin
class ArticleRemoteSource(private val client: HttpClient) {

    suspend fun list(page: Int, tag: String?): List<ArticleDto> =
        client.get("articles") {
            parameter("page", page)
            tag?.let { parameter("tag", it) }
        }.body()

    suspend fun get(id: String): ArticleDto = client.get("articles/$id").body()

    suspend fun create(request: CreateArticleRequest, requestId: String): ArticleDto =
        client.post("articles") {
            setBody(request)                       // serialized by ContentNegotiation
            header("X-Request-Id", requestId)
        }.body()
}
```

- `client.get`, `post`, `put`, `patch` and `delete` return an `HttpResponse`.
- `response.body<T>()` deserializes. `response.bodyAsText()` gives the raw string.
- `response.status` and `response.headers` give metadata.
- `setBody()` with an object needs `ContentNegotiation` and a content type.
- Forms use `submitForm(formParameters = parameters { append("k", "v") })`. Multipart uses `submitFormWithBinaryData` with `formData { }`.

Notice there is no interface. The "API contract" is just your functions. That is flexible, but you must organize it yourself, for example one remote source class per feature.

### Threads and cancellation

Ktor calls are suspend functions and are main-safe: the engine does I/O on its own threads. Cancelling the calling coroutine cancels the request.

> **Pitfall:** `client.get("/articles")` with a leading `/` replaces the path from `defaultRequest`, just like Retrofit. With base `.../v1/`, it goes to `/articles`, not `/v1/articles`.

:::check
Q: Your KMP project calls `HttpClient()` in `commonMain` with no engine. How does iOS get an engine?
A: Ktor picks the engine found in that platform's dependencies, so `iosMain` must depend on `ktor-client-darwin`. Without an engine dependency it fails at runtime.
Q: Spot the bug: a repository function does `HttpClient(OkHttp) { ... }.get("users").body()` on every call.
A: It creates a new client, engine and connection pool per call, losing connection reuse and leaking resources because it is never closed. Create one client and inject it.
Q: Interview: Why use `preconfigured` with the OkHttp engine on Android?
A: It lets Ktor run on your app's existing `OkHttpClient`, so you share one connection pool and keep its cache, certificate pinner and interceptors instead of configuring them twice.
:::

## Ktor plugins and errors

The plugins every production Ktor client uses, and how Ktor reports non-2xx responses.

:::tldr
- `expectSuccess = true` makes non-2xx throw `ClientRequestException` (4xx) or `ServerResponseException` (5xx); the default is false.
- The `Auth` plugin's `bearer { refreshTokens { } }` refreshes on 401 and shares one refresh across parallel calls.
- `HttpRequestRetry` retries with backoff; limit it to idempotent requests.
:::

### The common plugins

- `ContentNegotiation` with `json()` turns bodies into objects using kotlinx.serialization.
- `Logging` logs requests and responses at a chosen `LogLevel`.
- `HttpTimeout` sets request, connect and socket timeouts. Override per request with `timeout { }`.
- `DefaultRequest`, configured with `defaultRequest { }`, sets base URL and headers.
- `Auth` handles bearer tokens and refresh.
- `HttpRequestRetry` retries with backoff.
- `HttpCache` is an in-memory HTTP cache by default. With the OkHttp engine, OkHttp's own disk cache also works.
- `WebSockets` enables WebSocket sessions.

### Logging

```kotlin
install(Logging) {
    logger = object : Logger {
        override fun log(message: String) { Log.d("Http", message) }
    }
    level = if (BuildConfig.DEBUG) LogLevel.HEADERS else LogLevel.NONE
    sanitizeHeader { header -> header == HttpHeaders.Authorization }
}
```

The same rules as OkHttp apply. Never log bodies or tokens in release builds.

### expectSuccess and errors

`expectSuccess` decides what a non-2xx status does.

- `expectSuccess = false` (the default) returns the `HttpResponse` normally. You check `response.status.isSuccess()` yourself. Calling `body<T>()` on an error response usually fails with a confusing deserialization error.
- `expectSuccess = true` throws a `ResponseException` subclass: `RedirectResponseException` for 3xx, `ClientRequestException` for 4xx, and `ServerResponseException` for 5xx. Each has a `response` property.

Redirects are followed by default, so the 3xx exception is rare in practice.

```kotlin
suspend fun <T> safeKtorCall(block: suspend () -> T): Outcome<T> = try {
    Outcome.Success(block())
} catch (e: CancellationException) {
    throw e
} catch (e: ClientRequestException) {
    Outcome.Failure(when (e.response.status) {
        HttpStatusCode.Unauthorized -> DataError.Unauthorized
        HttpStatusCode.NotFound -> DataError.NotFound
        else -> DataError.Validation(e.response.bodyAsText())
    })
} catch (e: ServerResponseException) {
    Outcome.Failure(DataError.Server(e.response.status.value))
} catch (e: HttpRequestTimeoutException) {
    Outcome.Failure(DataError.Timeout)
} catch (e: IOException) {
    Outcome.Failure(DataError.NoInternet)
}
```

> **Note:** `java.io.IOException` does not exist in common KMP code. Ktor 3 is built on kotlinx-io, so use `kotlinx.io.IOException` there.

### Bearer auth with refresh

```kotlin
install(Auth) {
    bearer {
        loadTokens { tokenStore.load()?.let { BearerTokens(it.access, it.refresh) } }
        refreshTokens {
            val refresh = oldTokens?.refreshToken ?: return@refreshTokens null
            val dto: TokenDto = client.post("auth/refresh") {
                markAsRefreshTokenRequest()
                setBody(RefreshRequest(refresh))
            }.body()
            tokenStore.save(dto)
            BearerTokens(dto.accessToken, dto.refreshToken)
        }
        sendWithoutRequest { request -> request.url.host == "api.example.com" }
    }
}
```

- `loadTokens` gives the starting tokens. Ktor caches them in memory.
- `refreshTokens` runs on a 401. Return new tokens to retry, or `null` to give up.
- `markAsRefreshTokenRequest()` stops the refresh call itself from triggering another refresh.
- `sendWithoutRequest` decides whether the token is sent up front or only after a 401. Limit it to your own hosts so tokens never leak.
- Parallel 401s share one refresh. This is the `Mutex` you write by hand for OkHttp.

> **Pitfall:** Ktor caches loaded tokens. After logout, or after you save tokens elsewhere, call `clearToken()` on the bearer provider, or the client keeps sending the old ones.

### Retry

```kotlin
install(HttpRequestRetry) {
    retryOnServerErrors(maxRetries = 3)
    retryOnException(maxRetries = 3, retryOnTimeout = true)
    exponentialDelay()
}
```

Think about idempotency, as with OkHttp. Use `retryIf { request, response -> ... }` to retry only safe methods.

:::deeper Streaming and WebSockets
For large downloads, use `prepareGet(url).execute { response -> }`. The body is not loaded into memory. Inside the block, read `response.bodyAsChannel()` in chunks. The response is released when the block ends.

WebSockets keep one connection open for two-way messages, for chat, live scores or presence.

```kotlin
val client = HttpClient(OkHttp) { install(WebSockets) }

client.webSocket("wss://chat.example.com/ws") {
    send(Frame.Text("""{"type":"join","room":"general"}"""))
    for (frame in incoming) {
        if (frame is Frame.Text) handleMessage(frame.readText())
    }
}
```

With plain OkHttp, the equivalent is `okHttpClient.newWebSocket(request, listener)`. Either way, plan reconnects with backoff, because mobile networks drop connections often.
:::

:::check
Q: `expectSuccess` is left at its default and the server returns 404 with `{"message":"not found"}`. You call `.body<ArticleDto>()`. What happens?
A: No HTTP exception is thrown. Ktor tries to parse the error JSON as `ArticleDto` and fails with a serialization error, which hides the real cause. Check the status first or set `expectSuccess = true`.
Q: The refresh request inside `refreshTokens` forgets `markAsRefreshTokenRequest()`, and the refresh endpoint returns 401. What can happen?
A: The refresh call itself is treated as a normal request needing auth, so it can try to refresh again, looping or hanging. Mark it so Ktor skips auth handling for it.
Q: Interview: What does `expectSuccess` do in Ktor?
A: When true, a non-2xx response throws `RedirectResponseException`, `ClientRequestException` or `ServerResponseException`, each with the `response`. When false, the default, you get the `HttpResponse` and must check `status` before calling `body()`.
:::

## Retrofit vs Ktor

How to compare the two clients fairly, and how the choice changes in a Kotlin Multiplatform project.

:::tldr
- Retrofit is an annotated interface on top of OkHttp, Android and JVM only; Ktor is a DSL with pluggable engines on every platform.
- For KMP or a data layer shared with iOS, Ktor is the answer, because Retrofit cannot run on iOS.
- On Android both can run on OkHttp, so the choice is about API style, team and platforms, not speed.
:::

### Side by side

| Aspect | Retrofit | Ktor Client |
|---|---|---|
| Style | Annotated interface | Kotlin DSL and function calls |
| Platforms | Android and JVM only | Android, JVM, iOS, desktop, web |
| Transport | Always OkHttp | Pluggable engines, OkHttp on Android |
| Coroutines | Suspend support built in | Coroutine-native everywhere |
| Serialization | Converter factories (kotlinx, Moshi, Gson) | ContentNegotiation, usually kotlinx |
| Error on non-2xx | Throws `HttpException` for suspend `T` | Only if `expectSuccess` is true |
| Auth refresh | Write your own Authenticator | `Auth` plugin with bearer refresh |
| Endpoint overview | Whole API visible in one interface | Spread across functions unless you organize it |
| Testing | MockWebServer | MockEngine, no real socket |

### How to choose

- **Android-only app with an existing Retrofit codebase.** Stay with Retrofit. It is stable, well known, and every Android developer can read it.
- **Kotlin Multiplatform, or sharing the data layer with iOS.** Use Ktor. Retrofit depends on Java reflection and OkHttp, so it cannot run on iOS.
- **New Android-only app.** Either is fine. Retrofit gives a clear, declarative contract per endpoint. Ktor gives more flexibility and an easy path to KMP later.

> **Interview:** Do not say "Ktor is better" or "Retrofit is old". Name what drives the choice: platforms, team familiarity, existing code, and whether you need engine flexibility. Mention that both can run on OkHttp on Android.

### The KMP angle

In a KMP project the network layer usually lives in `commonMain`. Only the engine is platform-specific.

```kotlin
// commonMain
fun createHttpClient(engine: HttpClientEngine, json: Json): HttpClient =
    HttpClient(engine) {
        expectSuccess = true
        install(ContentNegotiation) { json(json) }
        install(HttpTimeout) { requestTimeoutMillis = 30_000 }
        defaultRequest { url("https://api.example.com/v1/") }
    }

// androidMain:  createHttpClient(OkHttp.create(), json)
// iosMain:      createHttpClient(Darwin.create(), json)
```

The factory takes an engine as a parameter. Each platform passes its own engine, and tests pass `MockEngine`. The plugin setup is written once.

What changes in common code:

- No `java.io` or `java.util`. Use kotlinx-io, kotlinx-datetime, and Kotlin's own types.
- Serialization must be kotlinx.serialization. Moshi and Gson are JVM-only.
- DI is usually Koin or manual, since Hilt is Android-only.

### Migrating from Retrofit to Ktor

You rarely rewrite everything at once. A safe path:

1. Keep one shared `OkHttpClient`. Give it to Ktor with `preconfigured`, so auth, pinning and cache behave the same.
2. Hide each API behind a data source interface. The repository should not care which client implements it.
3. Move one feature at a time, with MockEngine tests proving the same requests and parsing.
4. Move the data source to `commonMain` once it has no Android or Java imports.

> **Pitfall:** If Ktor reuses an `OkHttpClient` that has your OkHttp `Authenticator`, do not also install Ktor's `Auth` plugin. Two refresh mechanisms will fight over the same 401.

### What stays the same

Most of what you learned for Retrofit carries over. One shared client. DTOs mapped to domain models. A sealed error type. No raw exceptions in the UI. Only the API style and error types differ.

:::check
Q: Your team wants to share the data layer with an iOS app. A teammate suggests Retrofit with kotlinx.serialization. Will it work?
A: No. Retrofit relies on Java dynamic proxies and OkHttp, which do not exist on iOS. Using kotlinx.serialization does not change that; use Ktor in `commonMain`.
Q: Why does `createHttpClient` take an `HttpClientEngine` parameter instead of calling `HttpClient(OkHttp)` inside?
A: So each platform can pass its own engine and tests can pass `MockEngine`, while the plugin setup is written once in common code.
Q: Interview: Retrofit or Ktor for a new project?
A: Android-only: either works; Retrofit has a huge ecosystem and a clear annotated contract, Ktor is coroutine-native and easier to move to KMP. If iOS shares the code, Ktor, since Retrofit cannot run there. On Android, Ktor can use the OkHttp engine, so you keep OkHttp's strengths.
:::

## Architecture and pagination

Where the network layer sits, how it is wired with Hilt, and how paging APIs map to Paging 3.

:::tldr
- The API or remote source returns DTOs; the repository maps them to domain models and errors, and the UI sees only those.
- A Hilt `NetworkModule` provides `Json`, `OkHttpClient`, `Retrofit` and APIs as singletons.
- Prefer cursor pagination; use a `PagingSource` for network-only lists and a `RemoteMediator` with Room for offline-first.
:::

### Where the network layer lives

Network code belongs in the **data layer**. A typical shape:

- `ArticleApi` (Retrofit) or `ArticleRemoteSource` (Ktor) talks HTTP and returns DTOs.
- Mappers turn DTOs into domain models.
- `ArticleRepository` combines remote and local sources, maps errors, and exposes domain models as `Outcome` or `Flow`.
- ViewModels depend only on the repository interface.

```kotlin
fun ArticleDto.toDomain() = Article(
    id = ArticleId(id),
    title = title.trim(),
    publishedAt = Instant.parse(publishedAt),
    tags = tags.toSet(),
)
```

### An offline-first repository

```kotlin
class DefaultArticleRepository @Inject constructor(
    private val api: ArticleApi,
    private val dao: ArticleDao,
) : ArticleRepository {

    override fun observeArticles(): Flow<List<Article>> =
        dao.observeAll().map { rows -> rows.map { it.toDomain() } }

    override suspend fun refresh(): Outcome<Unit> =
        when (val result = safeApiCall { api.list(page = 1) }) {
            is Outcome.Success -> {
                dao.replaceAll(result.data.map { it.toEntity() })
                Outcome.Success(Unit)
            }
            is Outcome.Failure -> result
        }
}
```

The UI observes Room. The network only refreshes Room. If the refresh fails, the user still sees the last saved data, plus an error message.

Notice who does what. The API knows only HTTP and DTOs. The repository decides the data policy: when to fetch, what to store, how to map errors. The ViewModel only turns `Outcome` and domain models into UI state.

### Hilt NetworkModule

```kotlin
@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    @Provides @Singleton
    fun provideJson(): Json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    @Provides @Singleton
    fun provideOkHttp(
        @ApplicationContext context: Context,
        authInterceptor: AuthHeaderInterceptor,
        authenticator: TokenAuthenticator,
    ): OkHttpClient = OkHttpClient.Builder()
        .cache(Cache(File(context.cacheDir, "http_cache"), 20L * 1024 * 1024))
        .addInterceptor(authInterceptor)
        .authenticator(authenticator)
        .build()
```

The same object continues with Retrofit and the APIs.

```kotlin
    @Provides @Singleton
    fun provideRetrofit(client: OkHttpClient, json: Json): Retrofit = Retrofit.Builder()
        .baseUrl(BuildConfig.API_BASE_URL)
        .client(client)
        .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
        .build()

    @Provides @Singleton
    fun provideArticleApi(retrofit: Retrofit): ArticleApi = retrofit.create()
}
```

> **Pitfall:** `TokenAuthenticator` needs `RefreshApi`, which needs an `OkHttpClient`. If that is the same client, Hilt reports a dependency cycle. Provide a separate client and Retrofit with a qualifier such as `@AuthClient`.

> **Tip:** The first `OkHttpClient` build does disk and TLS setup. If profiling shows it on the main thread at launch, inject `dagger.Lazy<OkHttpClient>` or `Provider` in startup-critical classes.

### Pagination styles

- **Offset or page number.** `?page=3&size=20`. Simple, but items can be skipped or repeated when data changes between pages.
- **Cursor.** The response includes `nextCursor`, and you send `?after=<cursor>`. Stable under inserts and deletes. Preferred for feeds.

### A PagingSource over a cursor API

```kotlin
class FeedPagingSource(private val api: FeedApi) : PagingSource<String, FeedItem>() {

    override suspend fun load(params: LoadParams<String>): LoadResult<String, FeedItem> = try {
        val page = api.feed(after = params.key, limit = params.loadSize)
        LoadResult.Page(
            data = page.items.map { it.toDomain() },
            prevKey = null,
            nextKey = page.nextCursor,          // null means end of list
        )
    } catch (e: IOException) {
        LoadResult.Error(e)
    } catch (e: HttpException) {
        LoadResult.Error(e)
    }

    override fun getRefreshKey(state: PagingState<String, FeedItem>): String? = null
}
```

`LoadResult.Error` shows up in the UI as `LoadState.Error`, where you can show a retry footer.

For offline-first paging, use a `RemoteMediator` that writes pages into Room, and let Room's `PagingSource` drive the UI.

:::check
Q: A ViewModel imports `ArticleDto` and reads `dto.published_at`-style fields to build UI state. What is wrong?
A: The wire format leaks into the UI. A server rename now breaks the ViewModel. Map DTOs to domain models in the repository and expose only those.
Q: A feed uses `?page=N`. While the user scrolls, 3 new posts are added at the top. What might the user see on page 2?
A: Repeated items, because the offsets shifted by 3. Cursor pagination avoids this, since the cursor points at a specific item.
Q: Interview: Hilt reports a cycle between `OkHttpClient`, `TokenAuthenticator` and `RefreshApi`. How do you fix it?
A: Give the refresh API its own client and Retrofit, marked with a qualifier like `@AuthClient`, without the authenticator. That breaks the cycle and also prevents refresh recursion.
:::

## Testing the network layer

Testing real HTTP behavior with MockWebServer and Ktor's MockEngine, and keeping HTTP out of higher-layer tests.

:::tldr
- MockWebServer is a real local server: test your real Retrofit setup, URLs, headers and parsing together.
- Ktor's `MockEngine` swaps the engine for a lambda, so no socket is needed.
- ViewModel and use case tests use fake repositories, not HTTP.
:::

### MockWebServer for Retrofit and OkHttp

MockWebServer is a real HTTP server on localhost. Your real Retrofit and OkHttp code talks to it. So one test covers the URL, headers, JSON parsing and error mapping.

```kotlin
class ArticleApiTest {
    private val server = MockWebServer()
    private lateinit var api: ArticleApi

    @Before fun setUp() {
        server.start()
        api = Retrofit.Builder()
            .baseUrl(server.url("/"))
            .addConverterFactory(
                Json { ignoreUnknownKeys = true }.asConverterFactory("application/json".toMediaType())
            )
            .build()
            .create()
    }

    @After fun tearDown() = server.shutdown()
}
```

```kotlin
@Test fun `parses list and sends page query`() = runTest {
    server.enqueue(MockResponse().setResponseCode(200).setBody(
        """[{"id":"1","title":"Hi","published_at":"2026-01-01T00:00:00Z"}]"""
    ))

    val result = api.list(page = 2)

    assertEquals("1", result.first().id)
    assertEquals("/articles?page=2", server.takeRequest().path)
}
```

`enqueue` queues responses in order. `takeRequest()` returns what your code actually sent, so you can assert the path, headers and body.

> **Note:** This uses the OkHttp 4 `mockwebserver` API. OkHttp 5 adds `mockwebserver3` with an immutable, builder-style `MockResponse`. The ideas are the same.

Good things to test with MockWebServer:

- A 500 response maps to `DataError.Server(500)`.
- A 401 triggers the Authenticator, and the retried request carries the new token.
- Unknown JSON fields do not break parsing.
- A slow or missing response produces `DataError.Timeout`. Use a short timeout on the test client.

### Testing the refresh flow

```kotlin
@Test fun `401 refreshes once and retries with new token`() = runTest {
    server.enqueue(MockResponse().setResponseCode(401))
    server.enqueue(MockResponse().setResponseCode(200).setBody("""{"id":1,"name":"Ana"}"""))
    tokens.save(expiredTokens)

    api.getUser(1)

    server.takeRequest()                                   // the failed call
    val retry = server.takeRequest()
    assertEquals("Bearer new-access", retry.getHeader("Authorization"))
    assertEquals(1, fakeRefreshApi.calls)
}
```

Here `fakeRefreshApi` is a fake that returns `new-access` and counts calls. Faking it keeps the test focused on the Authenticator.

### Ktor MockEngine

Ktor can swap the engine for `MockEngine`. No socket, no server: just a lambda that receives the request and returns a response.

```kotlin
@Test fun `maps 404 to NotFound`() = runTest {
    val engine = MockEngine { request ->
        assertEquals("/v1/articles/42", request.url.encodedPath)
        respond(
            content = """{"message":"not found"}""",
            status = HttpStatusCode.NotFound,
            headers = headersOf(HttpHeaders.ContentType, "application/json"),
        )
    }
    val client = createHttpClient(engine, Json { ignoreUnknownKeys = true })

    val result = safeKtorCall { ArticleRemoteSource(client).get("42") }

    assertEquals(Outcome.Failure(DataError.NotFound), result)
}
```

Because `createHttpClient` takes the engine as a parameter, the test runs the real plugin setup: `expectSuccess`, content negotiation and the base URL.

> **Tip:** MockEngine tests can live in `commonTest` in a KMP project, so the same tests run on Android and iOS.

### Higher layers use fakes

ViewModel and use case tests should not touch HTTP. Give them a `FakeArticleRepository` that returns canned `Outcome` values.

```kotlin
class FakeArticleRepository : ArticleRepository {
    var nextRefresh: Outcome<Unit> = Outcome.Success(Unit)
    override fun observeArticles() = flowOf(emptyList<Article>())
    override suspend fun refresh() = nextRefresh
}
```

Keep MockWebServer and MockEngine tests at the data source and repository boundary. They are slower and more detailed. Above that, fakes are faster and clearer.

> **Pitfall:** Avoid mocking the Retrofit interface with Mockito to "test" a repository's networking. It proves nothing about URLs, headers or JSON. Use MockWebServer for that, and fakes for everything above.

:::check
Q: Your MockWebServer test enqueues one response, but the code under test makes two calls. What happens on the second call?
A: There is no queued response, so the second call waits for one and the test hangs until a timeout. Enqueue one response per expected request.
Q: Why build the Ktor test client with the same `createHttpClient` factory as production, instead of a bare `HttpClient(MockEngine)`?
A: So the test covers the real plugin setup, like `expectSuccess`, content negotiation and `defaultRequest`. A bare client would test a different configuration.
Q: Interview: How do you test the network layer?
A: For Retrofit and OkHttp, MockWebServer: enqueue responses, call the real API, and assert the parsed result and recorded request. For Ktor, inject `MockEngine`. Higher layers use fake repositories, not HTTP.
:::

## Review and cheat sheet

One screen of everything in this topic, plus the performance and security habits interviewers probe.

:::tldr
- Skim the cheat sheet before an interview; each row maps to an earlier lesson.
- Learn the performance and security lists as habits, not trivia.
- Do the five exercises: each one makes you build a piece you will be asked to explain.
:::

### Cheat sheet

| Topic | Remember |
|---|---|
| Idempotency | GET, HEAD, PUT, DELETE, OPTIONS; only auto-retry these |
| Status codes | 401 refresh, 403 not allowed, 429 back off, 5xx often temporary |
| Caching headers | `Cache-Control`, `ETag` with `If-None-Match` gives `304` |
| Retrofit internals | Dynamic proxy, cached `ServiceMethod`, `OkHttpCall`, converter, call adapter |
| Base URL | Must end with `/`; a leading `/` in a path drops the base path |
| Suspend | Uses `enqueue`, main-safe, cancels the call; streaming reads need `Dispatchers.IO` |
| Return types | `T` throws `HttpException`; `Response<T>` does not; both throw `IOException` |
| Serialization | kotlinx.serialization with `ignoreUnknownKeys = true`; avoid Gson in Kotlin |
| Errors | Sealed `DataError`, rethrow cancellation, read `errorBody()` once |
| OkHttp | One client, `newBuilder()` for variants; 10s timeouts, `callTimeout` off |
| Interceptors | Application for auth and logging; network for wire-level work |
| Token refresh | `Authenticator`, `Mutex` plus token comparison, separate refresh client |
| Cache | `Cache(dir, size)`; offline `onlyIfCached` plus `maxStale`; Room for offline-first |
| Pinning | `CertificatePinner` with a backup pin and a rotation plan |
| Ktor | `HttpClient(engine) { install(...) }`; OkHttp, Darwin, CIO engines |
| Ktor errors | `expectSuccess = true` throws Client or Server `ResponseException` |
| Ktor auth | `bearer { loadTokens; refreshTokens; markAsRefreshTokenRequest }` |
| Choice | Android-only: either; KMP: Ktor |
| Architecture | DTO to domain mappers, repository returns `Outcome` or `Flow` |
| Testing | MockWebServer, MockEngine, fakes above the data layer |

### Performance tips

- **One client.** One `OkHttpClient` and one `HttpClient` per backend, created once.
- **Connection reuse.** A shared client reuses TCP and TLS connections. HTTP/2 multiplexes many calls over one connection.
- **Compression.** OkHttp adds `Accept-Encoding: gzip` and unzips for you. If you set that header yourself, OkHttp stops decompressing and you must do it.
- **Close bodies.** With suspend `T`, Retrofit closes the body. With `ResponseBody`, use `use { }`.
- **Ask for less.** Paginate and filter on the server. Do not download 5,000 items to show 20.
- **Cache what is cacheable.** Ask the backend for proper `Cache-Control` and `ETag` headers.
- **Measure.** Use Android Studio's Network Inspector, and OkHttp's `EventListener` for DNS, connect, TLS and time to first byte.

### Security tips

- Never log bodies or auth headers in release builds. Redact sensitive headers even in debug.
- HTTPS only. Allow cleartext only for local debug hosts in the network security config.
- Store tokens encrypted with an Android Keystore key, not in plain `SharedPreferences`.
- Do not ship secrets in the APK. Anything in it can be extracted.
- Send auth headers only to your own hosts.
- Consider certificate pinning for high-risk apps, with backup pins.

### The pitfalls that come up most

- A new `OkHttpClient`, `Retrofit` or `HttpClient` per request or per repository.
- Swallowing `CancellationException` with `runCatching` or `catch (e: Exception)`.
- Forgetting `ignoreUnknownKeys = true`.
- Calling Ktor `body<T>()` on an error response with `expectSuccess = false`.
- Auto-retrying a POST.
- Refreshing tokens in parallel without a lock, or through the authenticated client.
- `BODY` logging on a streaming download.

### Practice exercises

1. **Paged GitHub search.** Build a Retrofit `GitHubApi.searchRepos(query, page)` returning `Response<SearchDto>`. Parse the `Link` header for the next page URL and load it with an `@Url` method. Wrap it in a repository that returns `Outcome<List<Repo>>`.
2. **One refresh, many callers.** Write an `AuthHeaderInterceptor` and a `TokenAuthenticator` with a `Mutex` and token comparison. Fire three parallel calls that all get 401. Assert the refresh endpoint was called exactly once and all three calls succeeded.
3. **Conditional requests.** Add an OkHttp `Cache`. Use MockWebServer to return `Cache-Control: max-age=0` with an `ETag`. Make the same call twice, and assert the second request carries `If-None-Match` and that a `304` still gives you the body.
4. **KMP-ready Ktor client.** Re-implement the GitHub client with an `HttpClient` factory that takes an engine, plus `ContentNegotiation`, `HttpTimeout`, `Logging` and `defaultRequest`. Test success, 404 and timeout with `MockEngine`.
5. **Paging in airplane mode.** Build a Paging 3 feed over a cursor API with a retry footer on `LoadState.Error`. Then switch to a `RemoteMediator` that writes into Room, and compare both in airplane mode.

### References

- [Retrofit](https://square.github.io/retrofit/)
- [OkHttp](https://square.github.io/okhttp/)
- [OkHttp interceptors](https://square.github.io/okhttp/features/interceptors/)
- [OkHttp caching](https://square.github.io/okhttp/features/caching/)
- [OkHttp HTTPS and certificate pinning](https://square.github.io/okhttp/features/https/)
- [Ktor Client: create and configure](https://ktor.io/docs/client-create-and-configure.html)
- [Ktor Client engines](https://ktor.io/docs/client-engines.html)
- [Ktor Client authentication](https://ktor.io/docs/client-auth.html)
- [Ktor Client testing](https://ktor.io/docs/client-testing.html)
- [kotlinx.serialization guide](https://github.com/Kotlin/kotlinx.serialization/blob/master/docs/serialization-guide.md)
- [Android data layer guide](https://developer.android.com/topic/architecture/data-layer)
- [Network security configuration](https://developer.android.com/privacy-and-security/security-config)
- [Paging library overview](https://developer.android.com/topic/libraries/architecture/paging/v3-overview)
- [MDN HTTP caching](https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching)

:::check
Q: A repository wraps `api.getUser()` in `runCatching { }` and maps every failure to "No internet". Name two problems.
A: It swallows `CancellationException`, so cancelled work runs the error branch. And it reports 4xx, 5xx and parsing errors as "no internet", hiding real causes. Catch specific types and map them to a sealed error.
Q: Your Android app uses Retrofit, and you now need to share the data layer with iOS. What changes and what stays?
A: The HTTP client moves to Ktor in `commonMain`, with OkHttp and Darwin engines and kotlinx.serialization. The architecture stays: DTO mappers, a repository, sealed errors, and a shared client.
Q: Interview: Which requests is it safe to retry automatically, and how?
A: Idempotent ones: GET, HEAD, PUT, DELETE, OPTIONS. Retry on connection failures and 502, 503, 504 with exponential backoff and a limit, and respect `Retry-After` on 429. Retry a POST only if the server supports an idempotency key.
:::
