Almost every Android app talks to a server over HTTP. On Android the two main tools are **Retrofit** (a type-safe layer on top of OkHttp) and **Ktor Client** (a Kotlin-first, multiplatform client). These notes cover the HTTP basics interviewers expect, how Retrofit and OkHttp work, how Ktor compares, how to handle errors and auth, and how to wire, test, and secure the network layer.

## HTTP Refresher

You do not need to be a networking expert. You do need to speak HTTP clearly, because interviewers use it to check if you understand what your client library does.

### Methods, safety and idempotency

A **safe** method does not change server state. An **idempotent** method can be sent many times with the same effect as sending it once. Idempotency matters because it tells you which requests are safe to retry automatically.

| Method | Purpose | Safe | Idempotent | Has body |
|---|---|---|---|---|
| GET | Read a resource | Yes | Yes | No |
| HEAD | Like GET, headers only | Yes | Yes | No |
| POST | Create, or run an action | No | No | Yes |
| PUT | Replace a resource fully | No | Yes | Yes |
| PATCH | Partial update | No | Not guaranteed | Yes |
| DELETE | Remove a resource | No | Yes | Usually no |
| OPTIONS | Ask what is allowed | Yes | Yes | No |

> **Interview:** "Is it safe to retry a POST?" Not by default. A POST to create an order could create two orders. Servers solve this with an `Idempotency-Key` header: the client sends a unique key, and the server ignores duplicates with the same key.

### Status codes

- **2xx success.** `200 OK`, `201 Created`, `204 No Content` (no body).
- **3xx redirect.** `301`, `302`, `307`, `308`. OkHttp follows redirects by default. `304 Not Modified` means "use your cached copy".
- **4xx client error.** `400 Bad Request`, `401 Unauthorized` (not logged in or token expired), `403 Forbidden` (logged in but not allowed), `404 Not Found`, `409 Conflict`, `422 Unprocessable Entity` (validation), `429 Too Many Requests` (rate limited, often with `Retry-After`).
- **5xx server error.** `500`, `502 Bad Gateway`, `503 Service Unavailable`, `504 Gateway Timeout`. Often temporary, so often worth retrying with backoff.

> **Tip:** Remember the 401 vs 403 difference. 401 means "who are you?" and is the trigger for a token refresh. 403 means "I know who you are, and the answer is no". Refreshing the token will not fix a 403.

### Headers you should know

- `Content-Type` says what the body is, for example `application/json`.
- `Accept` says what the client wants back.
- `Authorization` carries credentials, for example `Bearer <token>`.
- `Accept-Encoding: gzip` asks for compressed responses. OkHttp adds this for you.
- `User-Agent`, `Accept-Language`, and custom headers like `X-Request-Id` for tracing.

### Caching headers

- `Cache-Control: max-age=60` means the response is fresh for 60 seconds.
- `Cache-Control: no-cache` means you may store it, but must revalidate before use.
- `Cache-Control: no-store` means do not store it at all. Use it for sensitive data.
- `ETag` is a version tag for a resource. The client sends it back in `If-None-Match`. If nothing changed, the server replies `304` with no body.
- `Last-Modified` and `If-Modified-Since` do the same thing with timestamps.

```http
GET /users/42 HTTP/1.1
If-None-Match: "v7"

HTTP/1.1 304 Not Modified
ETag: "v7"
```

### HTTPS and TLS at a high level

HTTPS is HTTP inside a TLS connection. During the TLS handshake, the server sends its certificate chain. The client checks that the chain leads to a trusted root certificate authority and that the certificate matches the host name. Then both sides agree on keys and encrypt all traffic. During the handshake, ALPN lets the client and server agree to use HTTP/2, which can multiplex many requests over one connection.

> **Note:** Since Android 9 (API 28), cleartext HTTP is blocked by default. You must opt in with a network security config, which you should only do for local development hosts.

## How Retrofit Works

Retrofit turns a Kotlin interface into an HTTP client. You describe each endpoint with annotations. Retrofit builds the implementation at runtime and uses OkHttp to send the request.

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

val userApi: UserApi = retrofit.create(UserApi::class.java)
// or: val userApi = retrofit.create<UserApi>()
```

### From interface to network call

1. `retrofit.create()` returns a **dynamic proxy** built with `java.lang.reflect.Proxy`. Every call on the interface goes into one `InvocationHandler`.
2. On the first call to a method, Retrofit parses that method's annotations and parameter types into a `ServiceMethod`. It caches it, so reflection cost is paid once per method.
3. The `ServiceMethod` holds a request factory (how to build the URL, headers, and body) plus the chosen converter and call adapter.
4. Each call builds an `okhttp3.Request`, wraps it in an `OkHttpCall`, and the call adapter decides how to expose it: a `Call<T>`, a suspend result, an RxJava type, and so on.
5. OkHttp runs the request through its interceptor chain and returns a raw `Response`. Retrofit uses the converter to turn the body into your type.

> **Under the hood:** For a `suspend` function, the Kotlin compiler adds a hidden `Continuation` parameter. Retrofit detects it, calls `enqueue()` on the OkHttp call, and resumes the coroutine from the callback with `suspendCancellableCoroutine`. Cancelling the coroutine cancels the HTTP call.

Because suspend functions use `enqueue()`, the call runs on OkHttp's own thread pool. You can call a Retrofit suspend function from `Dispatchers.Main` without blocking it. Wrapping it in `withContext(Dispatchers.IO)` is not needed.

> **Pitfall:** Retrofit validates a method only when it is first called. A typo like a missing `{id}` placeholder crashes at runtime, not at compile time. Use `validateEagerly(true)` in debug builds to fail fast at `create()`.

### Base URL rules

- The base URL **must end with** `/`, or Retrofit throws at build time.
- A relative path like `"users"` is appended to the base URL path.
- A path starting with `/`, like `"/users"`, replaces the whole path of the base URL. With base `https://api.example.com/v2/`, the path `"/users"` goes to `https://api.example.com/users` and drops `v2`.
- A full URL in the annotation or in `@Url` ignores the base URL entirely.

## Retrofit Annotations

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

- `@Path` fills a `{placeholder}`. Values are URL-encoded unless you set `encoded = true`.
- `@Query` adds `?key=value`. A `List` parameter repeats the key: `?tag=a&tag=b`.
- `@QueryMap` adds many query parameters at once.
- `@Url` is handy for "next page" links that the server returns as full URLs.
- Other method annotations: `@POST`, `@PUT`, `@PATCH`, `@DELETE`, `@HEAD`, `@OPTIONS`, and `@HTTP` for custom cases such as a DELETE with a body.

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

### Forms and multipart

```kotlin
interface AuthApi {
    @FormUrlEncoded
    @POST("oauth/token")
    suspend fun token(
        @Field("grant_type") grantType: String,
        @Field("refresh_token") refreshToken: String,
    ): TokenDto
}

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

- `@FormUrlEncoded` sends `application/x-www-form-urlencoded`, built from `@Field` or `@FieldMap`.
- `@Multipart` sends `multipart/form-data`, built from `@Part` or `@PartMap`. Use it for file uploads.

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

Without `@Streaming`, Retrofit reads the whole body into memory before returning. With it, you get the stream as soon as headers arrive. Reading the stream is blocking I/O, so move it to `Dispatchers.IO`, and always close the body.

## Return Types and Call Adapters

### The three common shapes

| Declared type | Non-2xx response | Network failure | Gives headers and code |
|---|---|---|---|
| `suspend fun x(): T` | Throws `HttpException` | Throws `IOException` | No |
| `suspend fun x(): Response<T>` | Returns normally, `isSuccessful` is false | Throws `IOException` | Yes |
| `fun x(): Call<T>` | You inspect the `Response` | `onFailure` or thrown from `execute()` | Yes |

```kotlin
// 1. Simple: throws on any non-2xx
suspend fun getUser(@Path("id") id: Long): UserDto

// 2. Full control: read code, headers, error body
suspend fun getUserResponse(@Path("id") id: Long): Response<UserDto>

val response = api.getUserResponse(42)
if (response.isSuccessful) {
    val user = response.body()                     // nullable
    val etag = response.headers()["ETag"]
} else {
    val code = response.code()
    val raw = response.errorBody()?.string()       // read once only
}

// 3. Legacy: Call<T> with execute() (blocking) or enqueue() (callback)
fun getUserCall(@Path("id") id: Long): Call<UserDto>
```

> **Pitfall:** `Response<T>` does not protect you from `IOException`. No internet, DNS failure, and timeouts still throw. You need a try/catch either way.

### Empty bodies

For `204 No Content` or endpoints where you do not care about the body, declare `Unit` (or `Response<Unit>`). Retrofit has built-in support for it and will not try to parse an empty body.

```kotlin
@DELETE("orders/{id}")
suspend fun delete(@Path("id") id: String): Response<Unit>
```

### Call adapters

A `CallAdapter.Factory` changes what a method can return. Suspend support is built in, so most Kotlin projects need no adapter. Older code uses `RxJava3CallAdapterFactory` to return `Single<T>` or `Observable<T>`.

Some teams write a custom call adapter so methods return a sealed result type directly, such as `suspend fun getUser(): NetworkResult<UserDto>`. Libraries like Sandwich and EitherNet do this. It removes try/catch from every repository, but it is extra code to own. A small `safeApiCall` helper, shown later, is usually enough.

> **Under the hood:** Retrofit attaches an `Invocation` tag to every OkHttp request. An interceptor can read `request.tag(Invocation::class.java)` to see which interface method and annotations produced the request. This is how you build "skip auth for this endpoint" annotations.

## Converters and Serialization

A `Converter.Factory` turns response bodies into objects and objects into request bodies. Retrofit tries converters in the order you add them, so put the JSON converter last if you also use something like a scalars converter.

### kotlinx.serialization

```kotlin
// build.gradle.kts: plugin "org.jetbrains.kotlin.plugin.serialization"
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
    coerceInputValues = true   // null for a non-null field with default uses the default
    explicitNulls = false      // do not send nulls; missing nullable fields become null
}
```

The converter is now part of the official Retrofit repository. Older projects used the Jake Wharton artifact with the same `asConverterFactory` name.

> **Pitfall:** By default `Json` throws on unknown keys. If you forget `ignoreUnknownKeys = true`, adding one field on the server can crash every installed version of your app.

### Comparing the three main converters

| Aspect | kotlinx.serialization | Moshi | Gson |
|---|---|---|---|
| How it works | Compiler plugin, generated serializers | Codegen (KSP) or reflection | Reflection |
| Kotlin null safety | Respected | Respected with Kotlin support | Ignored |
| Default values | Respected | Respected | Ignored |
| Multiplatform | Yes | No | No |
| Formats | JSON, Protobuf, CBOR and more | JSON | JSON |
| R8 and ProGuard | Few rules, no reflection | Few rules with codegen | Needs keep rules |
| Status | Active, Kotlin-first | Active | Maintenance mode |

> **Interview:** Why is Gson risky in Kotlin? Gson creates objects without calling the constructor. A non-null `val name: String` can end up holding `null`, and default values are skipped. The crash then happens far away, when you read the field.

### DTOs are not domain models

Keep `@Serializable` classes in the data layer as **DTOs** (data transfer objects). They mirror the server's JSON, including odd names and nullable fields. Map them to clean domain models before they leave the repository. Then a server rename changes one mapper, not your whole UI.

## Error Handling

### What can go wrong

- **No connection, DNS failure, timeout, connection reset.** These are `IOException` subclasses: `UnknownHostException`, `SocketTimeoutException`, `ConnectException`, and others.
- **Server said no.** Non-2xx status. With `suspend fun x(): T`, Retrofit throws `retrofit2.HttpException`, which has `code()` and `response()`.
- **Body did not match your model.** With kotlinx.serialization you get a `SerializationException`. This is a bug or a contract change, not a user problem.
- **Cancellation.** A `CancellationException` when the scope is cancelled. It is normal and must be rethrown.

### Map to a sealed result

Do not let raw exceptions reach the UI. The ViewModel should not know what `HttpException` is. Convert errors at the data layer boundary into a small, closed set of domain errors.

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
    throw e                                     // never swallow cancellation
} catch (e: HttpException) {
    Outcome.Failure(
        when (e.code()) {
            401 -> DataError.Unauthorized
            404 -> DataError.NotFound
            422 -> DataError.Validation(parseErrorMessage(e) ?: "Invalid input")
            in 500..599 -> DataError.Server(e.code())
            else -> DataError.Unknown(e)
        }
    )
} catch (e: SocketTimeoutException) {
    Outcome.Failure(DataError.Timeout)
} catch (e: IOException) {
    Outcome.Failure(DataError.NoInternet)
} catch (e: SerializationException) {
    Outcome.Failure(DataError.Serialization)
}
```

Note the order: `SocketTimeoutException` is an `IOException`, so it must be caught first.

### Parsing the error body

```kotlin
@Serializable
data class ApiErrorDto(val message: String? = null, val code: String? = null)

fun parseErrorMessage(e: HttpException): String? = runCatching {
    val raw = e.response()?.errorBody()?.string() ?: return null
    json.decodeFromString<ApiErrorDto>(raw).message
}.getOrNull()
```

> **Pitfall:** `errorBody().string()` consumes the stream. Calling it twice gives an empty string the second time. Read it once and keep the result.

> **Pitfall:** Avoid a bare `runCatching` around network calls in coroutines. It also catches `CancellationException`, so a cancelled screen keeps running its error branch. Catch specific types, or rethrow cancellation.

### Why not throw to the UI

- The UI would need to know library types, which couples it to Retrofit or Ktor.
- Uncaught exceptions in `viewModelScope` crash the app.
- A sealed error type forces you to handle each case with an exhaustive `when`, and it maps cleanly to user messages and retry buttons.
- Tests become simple: a fake repository returns `Outcome.Failure(DataError.NoInternet)`.

## OkHttp at a Working Level

Retrofit does not do networking itself. OkHttp does: connections, TLS, HTTP/2, redirects, retries, caching, and compression. Ktor's OkHttp engine uses it too.

### One client for the whole app

```kotlin
val okHttpClient = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(20, TimeUnit.SECONDS)
    .writeTimeout(20, TimeUnit.SECONDS)
    .callTimeout(30, TimeUnit.SECONDS)
    .cache(Cache(File(context.cacheDir, "http_cache"), 10L * 1024 * 1024))
    .addInterceptor(authHeaderInterceptor)
    .addInterceptor(loggingInterceptor)
    .authenticator(tokenAuthenticator)
    .build()
```

Each `OkHttpClient` owns a **connection pool** and a **dispatcher** (thread pool). Reusing one client means TCP and TLS connections are reused across requests, which saves a full handshake each time. Creating a client per request throws that away and leaks threads.

If one API needs a different timeout, derive a client from the shared one. It shares the pool and dispatcher.

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

> **Tip:** `readTimeout` is per gap, not total. A server that sends one byte every 9 seconds never trips it. Use `callTimeout` when you need a hard upper limit on the whole request.

### Interceptors

An interceptor sees the request on the way out and the response on the way back. It can change both, or short-circuit and return its own response.

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
| Cache hit | Still runs | Skipped, no network is used |
| Sees | The request as your code built it | The real request on the wire, including `Accept-Encoding: gzip` |
| Can short-circuit | Yes | No, must call `proceed()` once |
| Typical use | Auth header, logging, offline cache rules, mock responses | Inspect real traffic, rewrite response cache headers |

> **Interview:** "Where would you add an auth header, application or network interceptor?" Application. It runs once per call, sees your logical request, and you do not need wire-level details for it.

### Logging

```kotlin
val loggingInterceptor = HttpLoggingInterceptor().apply {
    level = if (BuildConfig.DEBUG) HttpLoggingInterceptor.Level.BODY
            else HttpLoggingInterceptor.Level.NONE
    redactHeader("Authorization")
    redactHeader("Cookie")
}
```

Levels are `NONE`, `BASIC` (request line and response code), `HEADERS`, and `BODY`. `BODY` reads the whole body into memory, which breaks streaming downloads and leaks personal data into Logcat.

### A simple retry interceptor

OkHttp already retries some connection failures silently (`retryOnConnectionFailure` is true by default). For server errors like 503, you can add your own retry, but only for idempotent methods.

```kotlin
class RetryInterceptor(private val maxRetries: Int = 2) : Interceptor {
    private val idempotent = setOf("GET", "HEAD", "PUT", "DELETE", "OPTIONS")

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        var response = chain.proceed(request)
        var attempt = 0
        while (request.method in idempotent && response.code in setOf(502, 503, 504) && attempt < maxRetries) {
            response.close()                          // must close before retrying
            Thread.sleep(500L * (1 shl attempt))      // simple exponential backoff
            attempt++
            response = chain.proceed(request)
        }
        return response
    }
}
```

> **Note:** `Thread.sleep` is acceptable here because interceptors run on OkHttp's background threads. Many teams prefer retrying at the repository level with coroutines and `delay`, which is easier to cancel and test.

### Dispatcher limits

OkHttp's `Dispatcher` limits concurrent async calls: 64 in total and 5 per host by default. If you fire 20 image requests to one host, only 5 run at once and the rest wait. You can change `maxRequestsPerHost`, but on HTTP/2 the real fix is often fewer, larger requests.

## Auth and Token Refresh

Most apps use a short-lived **access token** and a long-lived **refresh token**. When the access token expires, the server returns 401. The client should refresh once, retry the original request, and log the user out only if the refresh fails.

### The Authenticator

OkHttp calls an `Authenticator` when a response is 401. You return a new request to retry, or `null` to give up.

```kotlin
class TokenAuthenticator(
    private val tokens: TokenStore,
    private val refreshApi: RefreshApi,      // built on a client WITHOUT this authenticator
) : Authenticator {

    override fun authenticate(route: Route?, response: Response): Request? {
        if (responseCount(response) >= 2) return null          // avoid infinite loops
        val failedToken = response.request.header("Authorization")?.removePrefix("Bearer ")

        val newToken = synchronized(this) {
            val current = tokens.accessToken()
            if (current != null && current != failedToken) {
                current                                         // someone else refreshed already
            } else {
                refreshBlocking(failedToken)                    // null if refresh failed
            }
        } ?: run { tokens.clear(); return null }

        return response.request.newBuilder()
            .header("Authorization", "Bearer $newToken")
            .build()
    }

    private fun responseCount(response: Response): Int =
        generateSequence(response) { it.priorResponse }.count()
}
```

### The parallel refresh problem

Imagine a screen that loads 5 things at once. The token has expired, so all 5 get 401 at nearly the same time. A naive authenticator calls the refresh endpoint 5 times. Many servers rotate refresh tokens, so the first refresh invalidates the old refresh token. The other 4 refreshes fail, and the user gets logged out for no reason.

The fix has two parts:

1. **Serialize the refresh.** Only one thread may refresh at a time. In the `Authenticator`, which is blocking code, a `synchronized` block works. In coroutine code, use a `Mutex`.
2. **Check before refreshing.** Inside the lock, compare the token that failed with the current stored token. If they differ, another thread already refreshed, so just retry with the new token.

```kotlin
class TokenRefresher(private val tokens: TokenStore, private val api: RefreshApi) {
    private val mutex = Mutex()

    suspend fun refreshIfNeeded(failedToken: String?): String? = mutex.withLock {
        val current = tokens.accessToken()
        if (current != null && current != failedToken) return current
        val refresh = tokens.refreshToken() ?: return null
        safeApiCall { api.refresh(RefreshRequest(refresh)) }.let { result ->
            when (result) {
                is Outcome.Success -> result.data.also { tokens.save(it) }.accessToken
                is Outcome.Failure -> null
            }
        }
    }
}

// In the Authenticator, which must return synchronously:
private fun refreshBlocking(failed: String?) = runBlocking { refresher.refreshIfNeeded(failed) }
```

> **Pitfall:** Do not use the same `OkHttpClient` (with the same Authenticator) for the refresh call. If the refresh endpoint returns 401, you get recursion. Build the refresh API on a separate client from `newBuilder()` without the authenticator.

> **Note:** `runBlocking` inside an Authenticator is acceptable because it runs on an OkHttp worker thread, never the main thread. Keep the refresh call fast, and give the refresh client a short timeout.

> **Interview:** Interceptor or Authenticator for refresh? An interceptor can check expiry before sending (proactive refresh). The `Authenticator` reacts to a real 401 (reactive refresh). Many apps use both: refresh early if the token's expiry time has passed, and keep the Authenticator as the safety net.

## Caching and Certificate Pinning

### HTTP cache

OkHttp has a real disk cache that follows HTTP caching rules. You only need to give it a directory and a size.

```kotlin
val cache = Cache(File(context.cacheDir, "http_cache"), 20L * 1024 * 1024) // 20 MB
```

When the server sends good `Cache-Control` and `ETag` headers, OkHttp handles freshness and conditional requests for you. A cached response that is still fresh is returned with no network. A stale one is revalidated with `If-None-Match`, and a `304` reuses the cached body.

You can check where a response came from:

- `response.cacheResponse` is non-null if the cache was used.
- `response.networkResponse` is non-null if the network was used.
- Both are non-null for a conditional request that got a `304`.

### Offline cache

To show cached data when offline, an application interceptor can force the cache.

```kotlin
class OfflineCacheInterceptor(private val isOnline: () -> Boolean) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        var request = chain.request()
        if (!isOnline() && request.method == "GET") {
            request = request.newBuilder()
                .cacheControl(
                    CacheControl.Builder()
                        .onlyIfCached()
                        .maxStale(7, TimeUnit.DAYS)
                        .build()
                )
                .build()
        }
        return chain.proceed(request)
    }
}
```

If nothing is cached, OkHttp returns a synthetic `504 Unsatisfiable Request` instead of hitting the network.

Some apps also use a network interceptor to rewrite `Cache-Control` on responses when the server sends no caching headers. This works, but you are overriding the server's intent. Prefer fixing the headers on the server.

> **Tip:** The HTTP cache is not an offline-first strategy. For real offline support, store data in Room and make the database the single source of truth. The HTTP cache is a cheap bonus for read-only resources such as configs or images.

### Certificate pinning basics

Normal TLS trusts any certificate signed by any CA the device trusts. **Pinning** says: for this host, only accept a certificate chain that contains a public key with this hash. It protects against a compromised or rogue CA and makes basic interception harder.

```kotlin
val pinner = CertificatePinner.Builder()
    .add("api.example.com", "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
    .add("api.example.com", "sha256/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=") // backup
    .build()

val client = OkHttpClient.Builder().certificatePinner(pinner).build()
```

- Always pin at least one **backup** key. If the server rotates its key and you pinned only one, every installed app stops working until users update.
- Pinning can also be declared in the Android **network security config** XML with a `pin-set` and an expiration date.
- Pinning is a trade-off. Many teams pin only for high-risk apps like banking.

> **Pitfall:** A pinning mistake is one of the few bugs that can brick every installed version of your app at once, with no server-side fix. Plan key rotation with the backend team before you ship pins.

## Ktor Client

Ktor is JetBrains' HTTP framework. Ktor Client is the client half. It is built on coroutines from the start, uses a Kotlin DSL instead of annotations, and runs on Android, JVM, iOS, desktop, and web. That makes it the default choice for Kotlin Multiplatform (KMP) projects.

### Engines

Ktor separates the API from the engine that does the actual I/O. You add one engine per platform.

| Engine | Platforms | Notes |
|---|---|---|
| OkHttp | Android, JVM | HTTP/2, reuses OkHttp features, good default on Android |
| Android | Android | Based on HttpURLConnection, fewer features |
| CIO | JVM, Android, Native | Pure Kotlin coroutines, HTTP/1.x only |
| Darwin | iOS, macOS | Uses NSURLSession, the right choice for iOS |
| Js | Browser, Node | Uses fetch |

In KMP, `commonMain` depends on `ktor-client-core`. `androidMain` adds `ktor-client-okhttp`, and `iosMain` adds `ktor-client-darwin`. If you call `HttpClient()` with no engine, Ktor picks the engine found on the classpath.

### Creating a client

```kotlin
val client = HttpClient(OkHttp) {
    expectSuccess = true

    install(ContentNegotiation) {
        json(Json { ignoreUnknownKeys = true; explicitNulls = false })
    }
    install(HttpTimeout) {
        connectTimeoutMillis = 10_000
        socketTimeoutMillis = 20_000
        requestTimeoutMillis = 30_000
    }
    install(Logging) {
        logger = object : Logger {
            override fun log(message: String) { Log.d("Http", message) }
        }
        level = if (BuildConfig.DEBUG) LogLevel.HEADERS else LogLevel.NONE
        sanitizeHeader { header -> header == HttpHeaders.Authorization }
    }
    defaultRequest {
        url("https://api.example.com/v1/")
        contentType(ContentType.Application.Json)
    }
    engine {
        preconfigured = sharedOkHttpClient   // reuse the app's OkHttpClient
    }
}
```

> **Tip:** With the OkHttp engine, `preconfigured` lets Ktor reuse your existing `OkHttpClient`, so you keep its connection pool, cache, certificate pinner, and interceptors.

Like `OkHttpClient`, an `HttpClient` is expensive. Create one per app (or per backend) and share it. Call `client.close()` only when you truly are done, for example in a KMP library's teardown.

### Plugins

Ktor features are **plugins** you `install`. Common ones:

- `ContentNegotiation` with `json()` turns bodies into objects using kotlinx.serialization.
- `Logging` logs requests and responses at a chosen `LogLevel`.
- `HttpTimeout` sets request, connect, and socket timeouts. Timeouts can be overridden per request with `timeout { }`.
- `DefaultRequest` (configured with `defaultRequest { }`) sets base URL, headers, and content type for every request.
- `Auth` handles bearer tokens and refresh.
- `HttpRequestRetry` retries with backoff.
- `HttpCache` gives an in-memory HTTP cache by default. With the OkHttp engine, OkHttp's own disk cache also works.
- `WebSockets` enables WebSocket sessions.

### Making requests

```kotlin
class ArticleRemoteSource(private val client: HttpClient) {

    suspend fun list(page: Int, tag: String?): List<ArticleDto> =
        client.get("articles") {
            parameter("page", page)
            tag?.let { parameter("tag", it) }
        }.body()

    suspend fun get(id: String): ArticleDto =
        client.get("articles/$id").body()

    suspend fun create(request: CreateArticleRequest): ArticleDto =
        client.post("articles") {
            setBody(request)                    // serialized by ContentNegotiation
            header("X-Request-Id", UUID.randomUUID().toString())
        }.body()
}
```

- `client.get`, `post`, `put`, `patch`, `delete` return an `HttpResponse`.
- `response.body<T>()` deserializes. `response.bodyAsText()` gives the raw string.
- `response.status`, `response.headers` give metadata.
- `setBody()` needs `ContentNegotiation` and a content type for objects.
- Forms use `submitForm(formParameters = parameters { append("k", "v") })`. Multipart uses `submitFormWithBinaryData` with `formData { }`.

### expectSuccess and errors

`expectSuccess` decides what a non-2xx status does.

- `expectSuccess = false` (the default) returns the `HttpResponse` normally. You check `response.status.isSuccess()` yourself. If you call `body<T>()` on an error response, deserialization will likely fail with a confusing error.
- `expectSuccess = true` throws a `ResponseException` subclass: `RedirectResponseException` for 3xx, `ClientRequestException` for 4xx, and `ServerResponseException` for 5xx. Each has a `response` property.

```kotlin
suspend fun <T> safeKtorCall(block: suspend () -> T): Outcome<T> = try {
    Outcome.Success(block())
} catch (e: CancellationException) {
    throw e
} catch (e: ClientRequestException) {
    Outcome.Failure(
        when (e.response.status) {
            HttpStatusCode.Unauthorized -> DataError.Unauthorized
            HttpStatusCode.NotFound -> DataError.NotFound
            else -> DataError.Validation(e.response.bodyAsText())
        }
    )
} catch (e: ServerResponseException) {
    Outcome.Failure(DataError.Server(e.response.status.value))
} catch (e: HttpRequestTimeoutException) {
    Outcome.Failure(DataError.Timeout)
} catch (e: IOException) {
    Outcome.Failure(DataError.NoInternet)
}
```

> **Note:** In common KMP code, `java.io.IOException` is not available. Use `io.ktor.utils.io.errors.IOException` or the kotlinx-io equivalent for your Ktor version, or catch broader types and classify them.

### Bearer auth with refresh

```kotlin
install(Auth) {
    bearer {
        loadTokens {
            tokenStore.load()?.let { BearerTokens(it.access, it.refresh) }
        }
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

- `loadTokens` gives the initial tokens. Ktor caches them in memory.
- `refreshTokens` runs on a 401. Return new tokens to retry, or `null` to give up.
- `markAsRefreshTokenRequest()` stops the refresh call itself from triggering another refresh.
- `sendWithoutRequest` controls whether the token is sent up front or only after a 401 challenge. Limit it to your own hosts so tokens never leak to third parties.
- The bearer provider coordinates concurrent refreshes so parallel 401s share one refresh. This is the same problem you solve by hand with a `Mutex` in OkHttp.

> **Pitfall:** Ktor caches loaded tokens. After logout, or after you save tokens from somewhere else, clear the provider's cached tokens, or the client keeps sending the old ones.

### Retry

```kotlin
install(HttpRequestRetry) {
    retryOnServerErrors(maxRetries = 3)
    retryOnException(maxRetries = 3, retryOnTimeout = true)
    exponentialDelay()
}
```

Like the OkHttp interceptor, think about idempotency. You can use `retryIf { request, response -> ... }` to retry only safe methods.

### Streaming and WebSockets, briefly

For large downloads, use `prepareGet(...).execute { }` so the body is not loaded into memory. Inside the block, read `response.bodyAsChannel()` in chunks and write to a file. The response is released when the block ends.

```kotlin
client.prepareGet(url).execute { response ->
    val channel = response.bodyAsChannel()
    // read from channel in chunks and write to a file
}
```

WebSockets keep one connection open for two-way messages. They suit chat, live scores, and presence.

```kotlin
val client = HttpClient(OkHttp) { install(WebSockets) }

client.webSocket("wss://chat.example.com/ws") {
    send(Frame.Text("""{"type":"join","room":"general"}"""))
    for (frame in incoming) {
        if (frame is Frame.Text) handleMessage(frame.readText())
    }
}
```

With plain OkHttp, the equivalent is `okHttpClient.newWebSocket(request, listener)` with a `WebSocketListener`. In both cases, plan for reconnects with backoff, because mobile networks drop connections often.

## Retrofit vs Ktor

| Aspect | Retrofit | Ktor Client |
|---|---|---|
| Style | Annotated interface | Kotlin DSL and function calls |
| Platforms | Android and JVM only | Android, JVM, iOS, desktop, web |
| Transport | Always OkHttp | Pluggable engines, OkHttp on Android |
| Coroutines | Suspend support built in | Coroutine-native everywhere |
| Serialization | Converter factories (kotlinx, Moshi, Gson) | ContentNegotiation, usually kotlinx |
| Error on non-2xx | Throws `HttpException` for suspend T | Only if `expectSuccess` is true |
| Auth refresh | Write your own Authenticator | Auth plugin with bearer refresh |
| Maturity | Very mature, huge Android ecosystem | Mature, smaller Android-specific ecosystem |
| Endpoint overview | API surface is visible in one interface | Spread across functions unless you organize it |
| Testing | MockWebServer | MockEngine, no real socket needed |

How to choose:

- **Android-only app with an existing Retrofit codebase.** Stay with Retrofit. It is stable, well known, and every Android developer can read it.
- **Kotlin Multiplatform, or sharing the data layer with iOS.** Use Ktor. Retrofit cannot run on iOS.
- **New Android-only app.** Either is fine. Retrofit gives a clear contract per endpoint. Ktor gives more flexibility and an easier path to KMP later.

> **Interview:** Do not say "Ktor is better" or "Retrofit is old". Say what drives the choice: platforms, team familiarity, existing code, and whether you need the engine flexibility. Mention that both can run on top of OkHttp on Android.

## Architecture and Pagination

### Where the network layer lives

The network code belongs in the **data layer**. A typical shape:

- `ArticleApi` (Retrofit interface) or `ArticleRemoteDataSource` (Ktor) talks HTTP and returns DTOs.
- Mappers turn DTOs into domain models.
- `ArticleRepository` combines remote and local sources, maps errors, and exposes domain models and `Outcome` or `Flow`.
- ViewModels depend on the repository interface only.

```kotlin
fun ArticleDto.toDomain() = Article(
    id = ArticleId(id),
    title = title.trim(),
    publishedAt = Instant.parse(publishedAt),
    tags = tags.toSet(),
)

class DefaultArticleRepository @Inject constructor(
    private val api: ArticleApi,
    private val dao: ArticleDao,
) : ArticleRepository {

    override fun observeArticles(): Flow<List<Article>> =
        dao.observeAll().map { rows -> rows.map { it.toDomain() } }

    override suspend fun refresh(): Outcome<Unit> =
        safeApiCall { api.list(page = 1) }.let { result ->
            if (result is Outcome.Success) dao.replaceAll(result.data.map { it.toEntity() })
            result.map { }
        }
}
```

Here `Outcome.map` is a small extension you write yourself. The pattern is the offline-first one: the UI observes Room, and the network only refreshes Room.

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

> **Tip:** Hilt builds the `OkHttpClient` lazily, but the first build still does disk and TLS setup. Inject `dagger.Lazy<OkHttpClient>` or `Provider` in startup-critical classes if profiling shows network setup on the main thread at launch.

> **Pitfall:** If the `Authenticator` needs an API that needs the same `OkHttpClient`, Hilt reports a dependency cycle. Break it with a qualifier, such as `@AuthClient`, for a separate refresh client.

### Pagination over the network

APIs page in two main ways:

- **Offset or page number.** `?page=3&size=20`. Simple, but items can be skipped or repeated when data changes between pages.
- **Cursor.** The response includes `nextCursor`, and you send `?after=<cursor>`. Stable under inserts and deletes. Preferred for feeds.

A Paging 3 `PagingSource` over a cursor API:

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

For offline-first paging, use a `RemoteMediator` that writes pages into Room, and let Room's `PagingSource` drive the UI.

## Testing the Network Layer

### MockWebServer for Retrofit and OkHttp

MockWebServer is a real local HTTP server. Your real Retrofit and OkHttp code talks to it, so you test URLs, headers, JSON parsing, and error handling together.

```kotlin
class ArticleApiTest {
    private val server = MockWebServer()
    private lateinit var api: ArticleApi

    @Before fun setUp() {
        server.start()
        api = Retrofit.Builder()
            .baseUrl(server.url("/"))
            .addConverterFactory(Json { ignoreUnknownKeys = true }
                .asConverterFactory("application/json".toMediaType()))
            .build()
            .create()
    }

    @After fun tearDown() = server.shutdown()

    @Test fun `parses list and sends page query`() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            """[{"id":"1","title":"Hi","published_at":"2026-01-01T00:00:00Z"}]"""
        ))
        val result = api.list(page = 2)
        assertEquals("1", result.first().id)
        val recorded = server.takeRequest()
        assertEquals("/articles?page=2", recorded.path)
    }
}
```

> **Note:** The example uses the OkHttp 4 `mockwebserver` API. OkHttp 5 adds `mockwebserver3` with a builder-style `MockResponse`. The ideas are the same.

Useful things to test with MockWebServer:

- A 500 response maps to `DataError.Server(500)`.
- A 401 triggers the Authenticator and the retry carries the new token.
- Unknown JSON fields do not crash parsing.
- `setSocketPolicy` or a slow body (`throttleBody`) produces a timeout error.

### Ktor MockEngine

Ktor can swap the engine for `MockEngine`. No socket, no server, just a lambda that receives the request and returns a response.

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
    val client = HttpClient(engine) {
        expectSuccess = true
        install(ContentNegotiation) { json() }
        defaultRequest { url("https://api.example.com/v1/") }
    }
    val result = safeKtorCall { ArticleRemoteSource(client).get("42") }
    assertEquals(Outcome.Failure(DataError.NotFound), result)
}
```

> **Tip:** Build the `HttpClient` in a function that takes an engine as a parameter. Production passes `OkHttp`, tests pass `MockEngine`, and both share the same plugin setup.

### Higher layers use fakes

ViewModel and repository tests should not touch HTTP at all. Give them a `FakeArticleRepository` or a fake data source that returns canned `Outcome` values. Keep MockWebServer and MockEngine tests for the data source and repository boundary.

## Performance, Security and Pitfalls

### Performance tips

- **One client.** One `OkHttpClient` and one `HttpClient` per backend, created once. Use `newBuilder()` for variants.
- **Connection reuse.** Reusing a client reuses TCP and TLS connections. HTTP/2 multiplexes many calls over one connection.
- **Compression.** OkHttp adds `Accept-Encoding: gzip` and unzips responses for you. If you set that header yourself, OkHttp stops decompressing and you must do it manually.
- **Close bodies.** Every `ResponseBody` must be closed. With suspend `T` returns, Retrofit does it for you. With `ResponseBody` or `Response<ResponseBody>`, use `use { }`.
- **Paginate and filter on the server.** Do not download 5,000 items to show 20.
- **Cache what is cacheable.** Ask the backend for proper `Cache-Control` and `ETag` headers.
- **Measure.** Use Android Studio's Network Inspector, and OkHttp's `EventListener` for timing DNS, connect, TLS, and time to first byte.

### Security tips

- Never log bodies or auth headers in release builds. Use `Level.NONE` or `LogLevel.NONE`, and redact sensitive headers even in debug.
- Use HTTPS only. Keep `cleartextTrafficPermitted` off except for local debug hosts.
- Store tokens in encrypted storage, not plain `SharedPreferences`.
- Do not hardcode secrets or API keys in the app. Anything in the APK can be extracted.
- Send auth headers only to your own hosts. Check the host in your interceptor if one client talks to several domains.
- Consider certificate pinning for high-risk apps, with backup pins and a rotation plan.

### Common pitfalls

- Creating a new `Retrofit`, `OkHttpClient`, or `HttpClient` for each request or each repository.
- Base URL without a trailing `/`, or a path with a leading `/` that drops part of the base path.
- Swallowing `CancellationException` with `runCatching` or `catch (e: Exception)`.
- Forgetting `ignoreUnknownKeys = true`.
- Using Gson with Kotlin non-null types and default values.
- Reading `errorBody()` twice.
- Calling `body<T>()` in Ktor on an error response with `expectSuccess = false`.
- Retrying non-idempotent POSTs automatically.
- Refreshing tokens in parallel without a lock.
- Using the authenticated client for the refresh call itself.
- `HttpLoggingInterceptor.Level.BODY` on a streaming download, which loads the whole file into memory.
- Leaking DTOs into the UI layer.

## Interview Questions

### Q: How does Retrofit turn an interface into working code?

`retrofit.create()` returns a dynamic proxy. When a method is called, Retrofit parses its annotations and parameter types once into a cached `ServiceMethod`. That holds a request factory, a converter, and a call adapter. Each call builds an OkHttp `Request`, wraps it in an `OkHttpCall`, and the call adapter exposes it as `Call<T>`, a suspend result, or another type.

### Q: Do you need withContext(Dispatchers.IO) around a Retrofit suspend call?

No. Retrofit's suspend support calls `enqueue()`, so the network work happens on OkHttp's thread pool and the coroutine just suspends. It is main-safe. You do need `Dispatchers.IO` if you read a streaming `ResponseBody` yourself, because that is blocking I/O.

### Q: suspend fun returning T vs Response<T>?

Returning `T` throws `HttpException` for non-2xx and gives no access to headers on success. `Response<T>` returns normally for any status and gives the code, headers, and error body. Both throw `IOException` for network failures. Use `Response<T>` when you need headers such as `ETag` or pagination links, or want to branch on status codes.

### Q: Application vs network interceptor?

Application interceptors run once per call, see your logical request, still run on cache hits, and can short-circuit. Network interceptors run for every network request, including redirects and retries, see the real wire request with headers like `Accept-Encoding`, and are skipped when the cache answers. Auth and logging usually go in application interceptors.

### Q: How do you refresh an expired token?

Use an OkHttp `Authenticator`, which OkHttp calls on a 401. It refreshes the token with a separate client, saves it, and returns the original request with the new header. It returns `null` to give up, and checks `priorResponse` to avoid loops. In Ktor, use the `Auth` plugin's `bearer { refreshTokens { } }`.

### Q: What happens when five requests get 401 at the same time?

A naive implementation refreshes five times, and with rotating refresh tokens the later refreshes fail and log the user out. Serialize refresh with a lock (`synchronized` in the Authenticator, or a `Mutex` in coroutine code). Inside the lock, compare the failed request's token with the stored one. If they differ, another call already refreshed, so retry with the stored token.

### Q: How do you handle errors from the network layer?

Catch at the data layer boundary and map to a sealed domain error: no internet, timeout, unauthorized, not found, server, validation, serialization, unknown. Rethrow `CancellationException`. Return a sealed `Outcome` to the ViewModel, which maps errors to UI messages. The UI never sees `HttpException` or `IOException`.

### Q: Why prefer kotlinx.serialization over Gson?

Gson uses reflection and bypasses Kotlin constructors, so non-null fields can hold null and default values are ignored. kotlinx.serialization uses a compiler plugin, respects nullability and defaults, needs few R8 rules, and works in Kotlin Multiplatform. Moshi with codegen is also a solid Android-only choice.

### Q: Why should OkHttpClient be a singleton?

Each client owns a connection pool and a thread pool. Sharing one client reuses connections, which avoids repeated TCP and TLS handshakes and saves memory and threads. For a variant, use `newBuilder()`, which shares the pool and dispatcher.

### Q: Explain readTimeout vs callTimeout.

`readTimeout` is the longest allowed gap between two reads of data, so a slow but steady response never trips it. `callTimeout` limits the whole call from start to finish, including DNS, connect, redirects, and reading the body. It is off by default.

### Q: How does OkHttp's cache work and how would you show data offline?

Give OkHttp a `Cache` with a directory and size. It follows `Cache-Control`, `ETag`, and `Last-Modified`, serves fresh responses from disk, and revalidates stale ones with conditional requests. For offline, an application interceptor can add `onlyIfCached` with `maxStale` when there is no network. For real offline-first behaviour, store data in Room and treat it as the source of truth.

### Q: What is certificate pinning and what is the risk?

Pinning makes the client accept a host's certificate only if the chain contains a public key whose hash you ship in the app. It defends against rogue or compromised CAs. The risk is that if the server key changes and you did not pin a backup, every installed app fails to connect until users update.

### Q: Retrofit or Ktor for a new project?

For Android only, both work. Retrofit is the standard with a huge ecosystem and a clear annotated contract. Ktor is coroutine-native, uses engines, and runs on iOS, so it is the choice for KMP or shared data layers. On Android, Ktor can use the OkHttp engine, so you keep OkHttp's strengths.

### Q: What does expectSuccess do in Ktor?

When true, any non-2xx response throws a `ResponseException` subclass: `RedirectResponseException`, `ClientRequestException`, or `ServerResponseException`. When false, the default, you get the `HttpResponse` and must check `status` yourself before calling `body()`.

### Q: How do you test the network layer?

For Retrofit and OkHttp, use MockWebServer: enqueue responses, call the real API, and assert the parsed result and the recorded request (path, headers, body). For Ktor, inject `MockEngine` and return canned responses. Higher layers use fake repositories, not HTTP.

### Q: Which requests is it safe to retry automatically?

Idempotent ones: GET, HEAD, PUT, DELETE, OPTIONS. Retry on connection failures and on 502, 503, or 504, with exponential backoff and a limit. Respect `Retry-After` on 429. Do not retry POST unless the server supports an idempotency key.

## Cheat Sheet, Practice and References

### One-screen cheat sheet

- Idempotent: GET, HEAD, PUT, DELETE, OPTIONS. Not: POST, and PATCH not guaranteed. Only auto-retry idempotent requests.
- 401 means refresh the token. 403 means not allowed. 429 means back off. 5xx is often temporary.
- Cache headers: `Cache-Control` (`max-age`, `no-cache`, `no-store`), `ETag` with `If-None-Match` gives `304`.
- Retrofit: interface + annotations, dynamic proxy, cached `ServiceMethod`, `OkHttpCall`. Base URL ends with `/`.
- Annotations: `@GET @POST @Path @Query @QueryMap @Body @Header @HeaderMap @FormUrlEncoded @Field @Multipart @Part @Url @Streaming`.
- Return types: `suspend T` throws `HttpException`. `suspend Response<T>` does not. Both throw `IOException`.
- Suspend calls are main-safe (they use `enqueue`). Reading a streaming body needs `Dispatchers.IO`.
- JSON: kotlinx.serialization with `ignoreUnknownKeys = true`. Avoid Gson in Kotlin.
- Errors: map to sealed `DataError` in the data layer. Rethrow `CancellationException`. Read `errorBody()` once.
- OkHttp: one client, `newBuilder()` for variants. Timeouts: connect, read, write (10s), call (off).
- Interceptors: application (`addInterceptor`) for auth and logging, network (`addNetworkInterceptor`) for wire-level work.
- Logging: `BODY` in debug only, `redactHeader("Authorization")`.
- Refresh: `Authenticator`, separate refresh client, `priorResponse` loop guard, lock plus token comparison.
- Cache: `Cache(dir, size)`. Offline: `onlyIfCached` + `maxStale`. Room for real offline-first.
- Pinning: `CertificatePinner` with a backup pin and a rotation plan.
- Ktor: `HttpClient(engine) { install(...) }`. OkHttp on Android, Darwin on iOS, CIO pure Kotlin.
- Ktor plugins: ContentNegotiation, Logging, HttpTimeout, defaultRequest, Auth bearer, HttpRequestRetry, WebSockets.
- Ktor errors: `expectSuccess = true` throws Client, Server, or Redirect `ResponseException`.
- Architecture: DTO to domain mappers, repository returns `Outcome` or `Flow`, Hilt `NetworkModule` with singletons.
- Testing: MockWebServer for Retrofit, MockEngine for Ktor, fakes above the data layer.

### Practice exercises

1. Build a Retrofit `GitHubApi` with `searchRepos(query, page)` returning `Response<SearchDto>`. Parse the `Link` header to get the next page URL, then load it with an `@Url` method. Wrap it in a repository that returns `Outcome<List<Repo>>` with a sealed `DataError`.
2. Write an `AuthHeaderInterceptor` and a `TokenAuthenticator` with a lock and token comparison. Use MockWebServer to enqueue three 401 responses for parallel calls, then one successful refresh. Assert that the refresh endpoint was called exactly once and all three calls succeeded.
3. Add an OkHttp `Cache` and an offline interceptor. Use MockWebServer to return a response with `Cache-Control: max-age=0` and an `ETag`. Make the same call twice and assert the second request carries `If-None-Match` and that a `304` still gives you the body.
4. Re-implement the GitHub client with Ktor in a KMP-friendly way: an `HttpClient` factory that takes an engine, plus `ContentNegotiation`, `HttpTimeout`, `Logging`, and `defaultRequest`. Test success, 404, and timeout with `MockEngine`.
5. Build a Paging 3 feed over a cursor-based API with Retrofit. Show a retry footer on `LoadState.Error`. Then switch to a `RemoteMediator` that writes pages into Room, and compare the user experience in airplane mode.

### References

- [Retrofit](https://square.github.io/retrofit/)
- [Retrofit on GitHub](https://github.com/square/retrofit)
- [OkHttp](https://square.github.io/okhttp/)
- [OkHttp interceptors](https://square.github.io/okhttp/features/interceptors/)
- [OkHttp caching](https://square.github.io/okhttp/features/caching/)
- [OkHttp HTTPS and certificate pinning](https://square.github.io/okhttp/features/https/)
- [OkHttp MockWebServer](https://github.com/square/okhttp/tree/master/mockwebserver)
- [Ktor Client overview](https://ktor.io/docs/client-create-and-configure.html)
- [Ktor Client engines](https://ktor.io/docs/client-engines.html)
- [Ktor Client authentication](https://ktor.io/docs/client-auth.html)
- [Ktor Client testing](https://ktor.io/docs/client-testing.html)
- [Ktor Client WebSockets](https://ktor.io/docs/client-websockets.html)
- [kotlinx.serialization guide](https://github.com/Kotlin/kotlinx.serialization/blob/master/docs/serialization-guide.md)
- [Moshi](https://github.com/square/moshi)
- [Android data layer guide](https://developer.android.com/topic/architecture/data-layer)
- [Network security configuration](https://developer.android.com/privacy-and-security/security-config)
- [Paging library overview](https://developer.android.com/topic/libraries/architecture/paging/v3-overview)
- [MDN HTTP caching](https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching)
- [MDN HTTP response status codes](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status)
