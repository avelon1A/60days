## Why Room and setup

What Room adds on top of plain SQLite, when to skip it, and how to set it up today with KSP and schema export.

:::tldr
- Room is a thin layer over SQLite: same engine, far less boilerplate and far fewer runtime bugs.
- Use KSP (not kapt) for the Room compiler, plus the `androidx.room` Gradle plugin.
- Export your schema to a `schemas/` folder and commit it; migrations and tests depend on it.
:::

### Problems with raw SQLite

Android has shipped SQLite since day one. You could always use `SQLiteOpenHelper` and `Cursor` directly. Room does not replace that engine. It replaces the boilerplate around it.

With raw SQLite:

- SQL lives in strings. A typo in a column name fails only at runtime, often in production.
- You map every `Cursor` row to an object by hand. Long, repetitive and easy to get wrong.
- Schema changes need hand-written upgrade code with no help to test it.
- Nothing tells the UI when data changes. You notify it yourself after every write.
- It is easy to query on the main thread and cause jank or ANRs.

### What Room adds

| Concern | Raw SQLite | Room |
|---|---|---|
| SQL errors | Runtime crash | Build error |
| Row mapping | Manual Cursor code | Generated |
| Observing changes | DIY | Flow, LiveData, PagingSource |
| Threading | Your problem | suspend functions + main-thread check |
| Migrations | Hand-written, untested | Migration, AutoMigration, test helper |
| Multiplatform | No | Yes, from 2.7 |

Room parses every `@Query` string during the build. A wrong table or column name is a build error, not a crash.

> **Interview:** Room is an abstraction over SQLite, not a different database. Anything SQLite can do, you can still do in a `@Query` or through the underlying connection.

### When not to use Room

- Simple key-value settings. Use DataStore.
- Large binary files such as images or video. Store them as files and keep only the path in Room.
- Pure caches with no querying needs. An in-memory map or a disk cache may be enough.

### Gradle with KSP

Room generates code with an annotation processor. Today that processor runs on **KSP** (Kotlin Symbol Processing). kapt is in maintenance mode and much slower. Since Room 2.7, Room generates Kotlin code by default when it runs on KSP.

```kotlin
// build.gradle.kts (module). Use current versions from the release notes.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.devtools.ksp")
    id("androidx.room")              // Room Gradle plugin
}

dependencies {
    implementation("androidx.room:room-runtime:$roomVersion")
    implementation("androidx.room:room-ktx:$roomVersion")
    ksp("androidx.room:room-compiler:$roomVersion")
    implementation("androidx.room:room-paging:$roomVersion")   // optional
    androidTestImplementation("androidx.room:room-testing:$roomVersion")
}
```

The KSP plugin version must match your Kotlin version.

### Schema export

Room can write a JSON file that describes your schema for every database version. Auto-migrations and migration tests need these files.

```kotlin
room {
    schemaDirectory("$projectDir/schemas")
}
```

The Room Gradle plugin passes this folder to KSP and keeps build caching correct. Without the plugin, you would pass the KSP argument `room.schemaLocation` yourself.

> **Tip:** Treat `schemas/` like source code. Commit it and review its diffs in pull requests. A surprising diff usually means a missing migration.

:::deeper Room and Kotlin Multiplatform
From Room 2.7, Room supports KMP. You declare the database in common code and plug in a `SQLiteDriver`.

- `BundledSQLiteDriver` (from `androidx.sqlite:sqlite-bundled`) ships its own SQLite build, so every platform runs the same SQLite version.
- On non-Android targets, the database class needs `@ConstructedBy`, pointing at an `expect object` that implements `RoomDatabaseConstructor`. Room generates the `actual`.
- APIs that mention `SupportSQLiteDatabase` or `Context` are Android-only. Common code uses the driver connection APIs instead.

Android-only apps keep working with the familiar builder and DAO APIs. You do not have to adopt the driver API to use Room 2.7 or 2.8.
:::

:::check
Q: You rename a column in an entity but forget to update one `@Query` that uses the old name. When do you find out with Room, and when with raw SQLite?
A: With Room, at build time: the processor checks the query against the schema and fails the build. With raw SQLite, at runtime, when that query runs and crashes.
Q: A teammate wants to store user-uploaded profile photos as BLOB columns in Room. What do you suggest?
A: Save the image as a file on disk and store only its path in Room. Large blobs bloat the database, slow every read and make queries and backups heavy.
Q: Interview: What changed in Room 2.7 that a senior candidate should know?
A: Kotlin Multiplatform support, KSP-first with Kotlin code generation by default, and a new driver API (`SQLiteDriver`, with a bundled SQLite option) plus coroutine-first connection APIs. Android-only apps keep the familiar builder and DAO APIs.
:::

## The three building blocks

How an entity, a DAO and a database class fit together, and what Room generates from them at build time.

:::tldr
- Entity = table, DAO = queries, Database = the class that lists entities and hands out DAOs.
- KSP generates `_Impl` classes that prepare statements, bind parameters and map rows for you.
- Room checks tables, columns, parameters and return types at compile time, but not logic or speed.
:::

### Entity, DAO, Database

Every Room setup has three parts.

1. **Entity**: a class that maps to a table.
2. **DAO** (Data Access Object): an interface with your queries.
3. **Database**: an abstract class that lists the entities and exposes the DAOs.

```kotlin
@Entity(tableName = "users")
data class UserEntity(
    @PrimaryKey val id: String,
    val name: String,
    val email: String,
)

@Dao
interface UserDao {
    @Query("SELECT * FROM users WHERE id = :id")
    suspend fun getById(id: String): UserEntity?

    @Upsert
    suspend fun upsert(user: UserEntity)
}

@Database(entities = [UserEntity::class], version = 1, exportSchema = true)
abstract class AppDatabase : RoomDatabase() {
    abstract fun userDao(): UserDao
}
```

### Building the database

```kotlin
val db = Room.databaseBuilder(
    context.applicationContext,
    AppDatabase::class.java,
    "app.db",
).build()
```

Use the **application** context. An Activity context would leak, because the database lives as long as the app.

Creating the object is cheap. The real file is opened (and created or migrated) on the first query.

### What the processor generates

At build time, Room generates:

- `AppDatabase_Impl`: creates the tables, holds the `InvalidationTracker`, and returns DAO instances.
- `UserDao_Impl`: the real code for each DAO method. It prepares SQL statements, binds parameters, reads rows and builds your objects.
- A schema JSON file in your schema folder, if export is on.

You can read the generated files under `build/generated/ksp/`. Reading one `_Impl` class once is the best way to demystify Room.

```kotlin
// Roughly what UserDao_Impl does for getById (simplified)
override suspend fun getById(id: String): UserEntity? =
    performSuspending(db, isReadOnly = true, inTransaction = false) { conn ->
        conn.prepare("SELECT * FROM users WHERE id = ?").use { stmt ->
            stmt.bindText(1, id)
            if (stmt.step()) UserEntity(
                id = stmt.getText(0),
                name = stmt.getText(1),
                email = stmt.getText(2),
            ) else null
        }
    }
```

Notice there is no reflection. Everything is plain generated code, which is fast and works with R8.

### What gets checked at compile time

Room knows your whole schema from the `@Entity` classes. It parses each `@Query` against that schema and checks:

- Table and column names.
- Bind parameters (`:id`) match function parameters.
- The return type can be built from the selected columns.
- Selected columns that do not match the return type produce a cursor mismatch warning.
- Every `@Relation` points at real columns.

What is **not** checked:

- Query performance. A missing index compiles fine.
- Logic bugs, such as the wrong `WHERE` condition.
- Anything built at runtime with `@RawQuery`.

> **Under the hood:** Room stores an identity hash of your schema inside the database file, in `room_master_table`. On open it compares that hash with the one it was compiled with. That is how it detects a schema change without a version bump.

> **Note:** The database instance must be a singleton per file in your process. A later lesson explains why; for now, create it once and share it.

:::check
Q: Your `@Query("SELECT id, name FROM users")` returns `List<UserEntity>`, where `UserEntity` also has a non-null `email`. What happens at build time?
A: Room cannot fill the `email` parameter from the selected columns, so it reports an error. Select all needed columns or return a smaller data class with only `id` and `name`.
Q: Why does Room use generated code instead of reflection to map rows?
A: Generated code is checked at build time, runs as fast as hand-written code, and survives R8 shrinking without keep rules. Reflection would be slower and fail only at runtime.
Q: Interview: What does Room generate at compile time?
A: An `_Impl` class for the database and for each DAO. The database impl creates tables and holds the InvalidationTracker; each DAO impl prepares statements, binds parameters and maps rows. With export on, it also writes one schema JSON per version.
:::

## Entities

How a Kotlin class becomes a table: primary keys, columns, indices, foreign keys and embedded objects.

:::tldr
- Every entity needs a primary key; prefer the server id for synced data and `Long` for auto-generated ids.
- `@ColumnInfo` renames columns and sets defaults; `@Ignore` skips a property; nullability maps to `NOT NULL`.
- Add indices for columns you filter, join or sort on; `@Embedded` flattens an object into the same table.
:::

### Primary keys

```kotlin
@Entity(tableName = "notes")
data class NoteEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val title: String,
    val body: String,
)
```

With `autoGenerate = true`, insert the object with `id = 0` and SQLite assigns the next id. `@Insert` returns the new row id as a `Long`.

- Use `Long` for auto-generated ids. SQLite row ids are 64-bit.
- For data from a server, use the **server id** as the primary key. That makes upserts trivial.
- For items created on the device that sync later, many teams use a UUID string.

When the key is a combination of columns, declare it on the entity.

```kotlin
@Entity(tableName = "playlist_song", primaryKeys = ["playlistId", "songId"])
data class PlaylistSongCrossRef(val playlistId: Long, val songId: Long)
```

### Column options

```kotlin
@Entity(tableName = "products")
data class ProductEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "display_name") val name: String,
    @ColumnInfo(name = "price_cents") val priceCents: Long,
    @ColumnInfo(defaultValue = "0") val stock: Int,
    @ColumnInfo(collate = ColumnInfo.NOCASE) val sku: String,
) {
    @Ignore var isSelected: Boolean = false
}
```

- `@ColumnInfo(name = ...)` renames the SQL column. Your Kotlin name stays clean.
- `defaultValue` matters for migrations that add a column.
- `@Ignore` tells Room not to store a property.
- Nullable Kotlin types become nullable columns. Non-null types get `NOT NULL`.

> **Pitfall:** Money as `Double` gives rounding errors. Store cents as a `Long`, or a decimal string, never a floating point number.

### Indices and unique constraints

An index speeds up lookups and sorting. A unique index also enforces uniqueness.

```kotlin
@Entity(
    tableName = "users",
    indices = [
        Index(value = ["email"], unique = true),
        Index(value = ["last_name", "first_name"]),
    ],
)
data class UserEntity(
    @PrimaryKey val id: String,
    val email: String,
    @ColumnInfo(name = "first_name") val firstName: String,
    @ColumnInfo(name = "last_name") val lastName: String,
)
```

Indices cost disk space and slow down writes a little. Add them for columns you filter, join or sort on often. Do not index everything.

### Foreign keys

```kotlin
@Entity(
    tableName = "comments",
    foreignKeys = [ForeignKey(
        entity = PostEntity::class,
        parentColumns = ["id"],
        childColumns = ["postId"],
        onDelete = ForeignKey.CASCADE,
    )],
    indices = [Index("postId")],
)
data class CommentEntity(@PrimaryKey val id: Long, val postId: Long, val text: String)
```

- `onDelete = CASCADE` deletes comments when their post is deleted.
- Room warns if the child column has no index. Without one, every parent change scans the whole child table.
- Foreign keys are optional. Apps that mirror a server often skip them, because data can arrive out of order.

### @Embedded

`@Embedded` flattens a nested object's fields into the parent table. There is no separate table.

```kotlin
data class Address(val street: String, val city: String, val zip: String)

@Entity(tableName = "customers")
data class CustomerEntity(
    @PrimaryKey val id: String,
    val name: String,
    @Embedded(prefix = "home_") val home: Address,
    @Embedded(prefix = "work_") val work: Address?,
)
```

The columns become `home_street`, `home_city`, `work_street` and so on. The `prefix` avoids name clashes when you embed the same type twice.

> **Note:** If every column of a nullable `@Embedded` object is null in a row, Room gives you `null` for the whole object.

:::check
Q: You insert `NoteEntity(id = 0, title = "a", body = "")` twice with `autoGenerate = true`. What ids do the rows get?
A: Two different ids, such as 1 and 2. With `autoGenerate`, an id of 0 means "not set", so SQLite assigns the next id each time.
Q: A comments table with a foreign key to posts has no index on `postId`. Why does deleting a post get slow as the table grows?
A: For each parent change, SQLite must find matching child rows. Without an index on `postId` that is a full table scan of comments.
Q: Interview: For data synced from a backend, would you use an auto-generated id or the server id as the primary key?
A: The server id. Upserts and deletes from the API then map directly to rows, with no lookup table and no risk of duplicates. Use a client UUID only for items created offline before the server knows them.
:::

## Type converters

How to store types SQLite does not know, like dates and enums, and why storing lists as JSON is usually a smell.

:::tldr
- SQLite stores only INTEGER, REAL, TEXT, BLOB and NULL; a `@TypeConverter` maps anything else.
- Store time as epoch millis and enums by name or a stable code, never by ordinal.
- JSON in a column is fine for small, never-queried data; anything you filter on needs its own table.
:::

### Why converters exist

SQLite has only five storage classes: INTEGER, REAL, TEXT, BLOB and NULL. Room maps Kotlin numbers, `Boolean`, `String` and `ByteArray` for you. For any other type you write a pair of functions: one to a stored type, one back.

### Dates and enums

```kotlin
class Converters {
    @TypeConverter
    fun instantToLong(value: Instant?): Long? = value?.toEpochMilli()

    @TypeConverter
    fun longToInstant(value: Long?): Instant? = value?.let(Instant::ofEpochMilli)

    @TypeConverter
    fun statusToCode(value: OrderStatus): String = value.code

    @TypeConverter
    fun codeToStatus(value: String): OrderStatus = OrderStatus.fromCode(value)
}

@Database(entities = [OrderEntity::class], version = 1)
@TypeConverters(Converters::class)
abstract class AppDatabase : RoomDatabase()
```

- Store timestamps as epoch millis (`Long`). They sort and compare correctly in SQL.
- Room has built-in enum support: it stores the enum name as TEXT. A custom converter gives you control, for example a stable code that survives renames.
- `@TypeConverters` can sit on the database, an entity, a DAO, a method or a field. The narrower scope wins.

> **Pitfall:** Storing enums by `ordinal` breaks the day someone reorders the enum. Old rows silently map to the wrong value.

> **Note:** Renaming an enum constant also breaks the default name-based storage. If enum names may change, use an explicit code.

### Lists, and why JSON is a smell

It is tempting to store a list as a JSON string.

```kotlin
class ListConverters {
    @TypeConverter
    fun fromTags(tags: List<String>): String = Json.encodeToString(tags)

    @TypeConverter
    fun toTags(json: String): List<String> = Json.decodeFromString(json)
}
```

This works for small, opaque data that you never query. It becomes a problem when:

- You want "all notes with tag X". SQL cannot index inside the JSON text, so you end up with slow `LIKE` queries.
- You want to change one item. You must rewrite the whole value.
- The JSON format changes. Old rows fail to decode at runtime, and the compiler cannot catch it.
- The list grows large. Every read pays the parse cost.

The relational answer is a separate table with a foreign key (one-to-many), or a junction table (many-to-many). The Relationships lesson shows both.

> **Interview:** "When would you store a list as JSON in Room?" Only for small data that is written together and never queried, such as a cached list of image URLs on an item.

### Converters with dependencies

By default Room creates the converter class itself, so it needs a no-argument constructor. If the converter needs a dependency, such as a configured JSON parser, mark it `@ProvidedTypeConverter` and pass an instance.

```kotlin
@ProvidedTypeConverter
class JsonConverters(private val json: Json) { /* @TypeConverter functions */ }

Room.databaseBuilder(context, AppDatabase::class.java, "app.db")
    .addTypeConverter(JsonConverters(json))
    .build()
```

If you forget `addTypeConverter`, Room throws when it first needs the converter.

### Converters versus @Embedded

Both handle "a field that is not a simple type". They solve it differently.

| Approach | Storage | Queryable |
|---|---|---|
| @TypeConverter | One column | Only as a whole value |
| @Embedded | One column per field | Yes, each field |
| Separate table | Its own rows | Yes, with joins and indices |

Pick `@Embedded` for a small fixed structure like an address. Pick a converter for a single value type like `Instant`.

:::check
Q: An `OrderStatus` enum is stored by name. A developer renames `SHIPPED` to `DISPATCHED`. What happens when old rows are read?
A: Decoding fails, because `valueOf("SHIPPED")` no longer finds a constant, and the read throws at runtime. A stable code column or a migration that rewrites the old values avoids it.
Q: Why store an `Instant` as epoch millis instead of a formatted string like "28 Nov 2026"?
A: Numbers sort and compare correctly in SQL, so `ORDER BY` and `WHERE createdAt > :t` work. A display string sorts alphabetically and depends on format and locale.
Q: Interview: Why is storing a list as JSON in a column considered a smell?
A: SQL cannot index or filter inside it, an update rewrites the whole value, and format changes break only at runtime. Anything you query belongs in its own table with a foreign key or junction.
:::

## DAOs

How to read and write with DAO methods: insert, update, delete, upsert, query, and the conflict strategies behind them.

:::tldr
- `@Insert`, `@Update`, `@Delete` and `@Upsert` are generated for you; `@Update` and `@Delete` match by primary key.
- `REPLACE` is a delete plus an insert and can cascade; prefer `@Upsert` for "insert or update".
- `@Query` handles everything else, with `:name` bind parameters checked at compile time.
:::

### Insert and conflict strategies

```kotlin
@Dao
interface NoteDao {
    @Insert                                         // default: ABORT
    suspend fun insert(note: NoteEntity): Long      // new row id

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertAll(notes: List<NoteEntity>): List<Long>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun replace(note: NoteEntity)
}
```

| Strategy | On conflict | Notes |
|---|---|---|
| ABORT | Throws SQLiteConstraintException | Default |
| IGNORE | Skips the row, returns -1 for it | Good for "insert if missing" |
| REPLACE | Deletes the old row, inserts the new one | Fires ON DELETE CASCADE |
| NONE | Behaves like ABORT | Rarely used |

`ROLLBACK` and `FAIL` still exist but are deprecated. They do not behave usefully inside Room's transactions.

> **Pitfall:** `REPLACE` is a delete followed by an insert. If child tables use `ON DELETE CASCADE`, replacing a parent silently wipes its children.

### Update, delete, upsert

```kotlin
@Update suspend fun update(note: NoteEntity): Int     // rows changed
@Delete suspend fun delete(note: NoteEntity): Int     // rows deleted
@Upsert suspend fun upsert(notes: List<NoteEntity>)
```

- `@Update` and `@Delete` match rows by primary key only. Other fields do not matter for matching.
- `@Upsert` (Room 2.5+) tries to insert. On a key conflict it updates the existing row instead. No delete, so no cascade surprise.
- All of these accept one object, a `List`, or `vararg`.

You can write only some columns with a smaller class.

```kotlin
data class NoteTitle(val id: Long, val title: String)

@Update(entity = NoteEntity::class)
suspend fun updateTitle(update: NoteTitle)
```

### @Query

`@Query` is where most real work happens.

```kotlin
@Query("SELECT * FROM notes WHERE id = :id")
suspend fun getById(id: Long): NoteEntity?

@Query("SELECT * FROM notes WHERE id IN (:ids)")
suspend fun getByIds(ids: List<Long>): List<NoteEntity>

@Query("SELECT * FROM notes WHERE title LIKE '%' || :q || '%' LIMIT :limit")
suspend fun search(q: String, limit: Int = 50): List<NoteEntity>

@Query("DELETE FROM notes WHERE updatedAt < :cutoff")
suspend fun deleteOlderThan(cutoff: Long): Int

@Query("SELECT COUNT(*) FROM notes")
suspend fun count(): Int
```

- Bind parameters with `:name`. Never build SQL by joining strings with user input.
- A collection parameter expands automatically inside `IN (:ids)`.
- `UPDATE` and `DELETE` queries can return `Int`, the number of affected rows.
- Return types can be an entity, any class whose fields match the columns, a primitive, a `List`, a nullable, a `Flow`, or a `PagingSource`.

A one-shot read is a `suspend fun`. An observed read returns a `Flow` and is not `suspend`. The next lesson covers that.

### Projections

Select only what the screen needs.

```kotlin
data class NoteListItem(
    val id: Long,
    val title: String,
    @ColumnInfo(name = "updatedAt") val updated: Long,
)

@Query("SELECT id, title, updatedAt FROM notes ORDER BY updatedAt DESC")
fun observeListItems(): Flow<List<NoteListItem>>
```

Reading fewer columns means less I/O and less memory. This matters a lot when the entity has a large `body` column.

:::deeper Multimap returns and raw queries
Since Room 2.4 a JOIN query can return a `Map` directly. It is an alternative to `@Relation` where you write the JOIN yourself.

```kotlin
@Query("SELECT * FROM artists JOIN songs ON artists.id = songs.artistId")
fun artistsWithSongs(): Flow<Map<ArtistEntity, List<SongEntity>>>
```

When the SQL shape is truly dynamic, such as a filter builder, use `@RawQuery`.

```kotlin
@RawQuery(observedEntities = [NoteEntity::class])
fun observeRaw(query: SupportSQLiteQuery): Flow<List<NoteEntity>>
```

You lose compile-time checking. `observedEntities` tells Room which tables to watch for the `Flow`. Prefer a normal `@Query` whenever you can.
:::

:::check
Q: A post has comments with `ON DELETE CASCADE`. You refresh posts from the server with `@Insert(onConflict = REPLACE)`. What happens to the comments?
A: They are deleted. REPLACE removes the old post row before inserting the new one, and the cascade deletes its children. `@Upsert` updates the row in place instead.
Q: You call `@Update` with a `NoteEntity` whose id does not exist in the table. What happens?
A: Nothing is written and the method returns 0. Update matches by primary key only and does not insert missing rows.
Q: Interview: What is the difference between `REPLACE` and `@Upsert`?
A: `REPLACE` deletes the conflicting row and inserts a new one, which fires delete triggers and cascades. `@Upsert` tries an insert and on conflict updates the existing row, so children and row identity stay intact.
:::

## Observable queries

How a Room `Flow` knows when to emit again, what that costs, and how paging builds on the same mechanism.

:::tldr
- A DAO function returning `Flow` (not `suspend`) emits the current result, then re-runs after every change to its tables.
- The `InvalidationTracker` uses SQLite triggers and works per table, not per row.
- `PagingSource` from Room uses the same invalidation to reload pages automatically.
:::

### Return a Flow

```kotlin
@Query("SELECT * FROM notes ORDER BY updatedAt DESC")
fun observeAll(): Flow<List<NoteEntity>>

@Query("SELECT * FROM notes WHERE id = :id")
fun observeById(id: Long): Flow<NoteEntity?>
```

- Do **not** mark a `Flow` DAO function as `suspend`. Creating the Flow is cheap; the work happens on collection.
- The Flow emits the current result when collected, then emits again every time an observed table changes.
- The query runs on Room's background threads. You can collect on any dispatcher.
- Room also supports `LiveData`, and RxJava types through `room-rxjava2` and `room-rxjava3`.

### How the InvalidationTracker works

Room has one `InvalidationTracker` per database instance.

1. When a table is first observed, Room installs SQLite **triggers** for INSERT, UPDATE and DELETE on it.
2. Each trigger marks the table as changed in a small internal tracking table.
3. After a write transaction ends, Room checks which tables were marked.
4. It notifies every observer that watches any of those tables.
5. For a `Flow`, that notification makes Room re-run the query and emit the new result.

> **Under the hood:** The tracker works at the **table** level, not the row level. Changing note 7 wakes up a Flow that only reads note 3, because both read the `notes` table.

Consequences you should know:

- A Flow can emit the **same** data again. Add `distinctUntilChanged()` if downstream work is expensive.
- A query that JOINs three tables re-runs when any of the three changes.
- Writes inside one transaction cause one notification, not one per row.
- Changes made outside this Room instance (another process, another instance on the same file) are not seen, unless you enable multi-instance invalidation.

```kotlin
val note: Flow<NoteEntity?> = noteDao.observeById(id)
    .distinctUntilChanged()
```

### Flow in the UI pipeline

```kotlin
class NotesViewModel(repo: NotesRepository) : ViewModel() {
    val notes: StateFlow<List<Note>> = repo.observeNotes()
        .stateIn(
            scope = viewModelScope,
            started = SharingStarted.WhileSubscribed(5_000),
            initialValue = emptyList(),
        )
}
```

With `WhileSubscribed`, collection stops when no one is watching. Room then removes the observer from the tracker, so no queries run in the background. The 5 second delay keeps the stream alive across a screen rotation.

> **Tip:** Observe the smallest query that serves the screen. Any change to the table re-runs it, so a narrow query is cheaper each time.

### Paging

Add `room-paging` and return a `PagingSource`.

```kotlin
@Query("SELECT * FROM notes ORDER BY updatedAt DESC")
fun pagingSource(): PagingSource<Int, NoteEntity>
```

Room generates a `PagingSource` that loads pages with `LIMIT` and `OFFSET`. When the table changes, the tracker invalidates the source, and Paging creates a new one and reloads around the current position.

For network plus database paging, pair it with a `RemoteMediator`. The mediator fetches pages from the API and writes them into Room. Room stays the single source of truth for what the list shows.

:::deeper Why a write sometimes does not reach your Flow
Common causes when a Flow does not update:

- The write went through a **different database instance**. Each instance has its own tracker.
- The write happened in another process without `enableMultiInstanceInvalidation()`.
- The write used raw SQL on a table that the Flow does not read, for example a view's base table that Room does not know you depend on.
- A `@RawQuery` Flow was declared without `observedEntities`.
- The Flow did emit, but `distinctUntilChanged()` dropped it because the result was equal.

The Database Inspector in Android Studio shows live table contents, which helps you tell "no write" apart from "no emission".
:::

:::check
Q: A screen observes `observeById(3)`. A background sync updates only note 7. Does the screen's Flow emit?
A: Yes. Invalidation is per table, so any write to `notes` re-runs the query. It emits the same note 3 again, which `distinctUntilChanged()` can filter.
Q: You insert 500 rows with one `insertAll` call while a Flow observes the table. Roughly how many emissions follow?
A: About one. `insertAll` runs in a single transaction, and the tracker notifies once after it commits.
Q: Interview: How does a Room Flow know when to re-emit?
A: Room's InvalidationTracker installs triggers on observed tables. After a write transaction, it checks which tables changed and notifies observers, and the Flow re-runs its query. It works per table, so it can emit identical data.
:::

## Relationships

How to load related data with `@Relation`, junction tables and JOINs, and why relation queries need `@Transaction`.

:::tldr
- Entities never hold other entities; you build result classes with `@Embedded` plus `@Relation`.
- Many-to-many uses a cross-ref entity and `associateBy = Junction(...)`.
- A relation runs several queries, so mark the DAO method `@Transaction` to read one consistent snapshot.
:::

### No object references, on purpose

Room does not let an entity hold a reference to another entity. That is deliberate. Lazy loading would hide database reads behind a simple property access, often on the main thread. Instead, you describe the shape you want in a result class.

### One-to-one and one-to-many

```kotlin
data class UserWithProfile(
    @Embedded val user: UserEntity,
    @Relation(parentColumn = "id", entityColumn = "userId")
    val profile: ProfileEntity?,
)

data class PostWithComments(
    @Embedded val post: PostEntity,
    @Relation(parentColumn = "id", entityColumn = "postId")
    val comments: List<CommentEntity>,
)

@Dao
interface PostDao {
    @Transaction
    @Query("SELECT * FROM posts ORDER BY createdAt DESC")
    fun observePostsWithComments(): Flow<List<PostWithComments>>
}
```

- `parentColumn` is a column in the `@Embedded` parent.
- `entityColumn` is the matching column in the child entity.
- A single object means one-to-one; a `List` means one-to-many.

### Many-to-many with a junction table

```kotlin
@Entity(
    tableName = "playlist_song",
    primaryKeys = ["playlistId", "songId"],
    indices = [Index("songId")],
)
data class PlaylistSongCrossRef(val playlistId: Long, val songId: Long)

data class PlaylistWithSongs(
    @Embedded val playlist: PlaylistEntity,
    @Relation(
        parentColumn = "playlistId",
        entityColumn = "songId",
        associateBy = Junction(PlaylistSongCrossRef::class),
    )
    val songs: List<SongEntity>,
)
```

Here `parentColumn` is the key column in `PlaylistEntity` and `entityColumn` is the key column in `SongEntity`. Room uses the cross-ref table to connect them. For the reverse view, `SongWithPlaylists`, write a second class with the roles swapped.

The index on `songId` matters. The composite key already indexes `playlistId` first, but lookups by song alone need their own index.

### Why @Transaction is needed

A relation query is **not** one SQL statement. Room runs:

1. Your main query, such as `SELECT * FROM posts`.
2. One more query per relation, such as `SELECT * FROM comments WHERE postId IN (...)`.

Without a transaction, another write can land between step 1 and step 2. You could get a post whose comments were deleted in between. `@Transaction` makes all queries read one consistent snapshot. Room warns at build time if you forget it.

> **Interview:** "Why does Room warn when you use @Relation without @Transaction?" Because it runs several queries to build the result, and without a transaction they can see different states of the database.

### Nested relations and partial children

- A `@Relation` can point at another relation class, for example `UserWithPlaylistsAndSongs` that holds `List<PlaylistWithSongs>`.
- Use `entity` plus `projection` to load only some child columns.

```kotlin
@Relation(
    parentColumn = "id",
    entityColumn = "postId",
    entity = CommentEntity::class,
    projection = ["text"],
)
val commentTexts: List<String>
```

### @Relation vs JOIN

| Approach | Pros | Cons |
|---|---|---|
| @Relation | Clean nested objects, no duplicated parents | Several queries, loads all children |
| JOIN into a flat class | One query, can filter on child columns | Parent data repeated on every row |
| JOIN into a Map | One query, grouped result | Less control over child order |

> **Pitfall:** `@Relation` always loads **all** matching children. You cannot add `WHERE` or `LIMIT` to the child query. To get "posts with their latest 3 comments", write a JOIN or a separate query.

:::check
Q: `PlaylistWithSongs` is returned from a `@Query` without `@Transaction`. What can go wrong while a sync job edits playlists?
A: The parent query and the songs query may see different database states, so a playlist can appear with songs from a moment later or earlier. Room also warns about it at build time.
Q: You need "each user with only their unread messages". Can `@Relation` do it directly?
A: No. `@Relation` loads every matching child and cannot filter. Use a JOIN, a `Map` return type, or a database view that already filters to unread messages.
Q: Interview: How do you model a many-to-many relationship in Room?
A: With a junction entity that holds both foreign keys as a composite primary key, plus an index on the second key. Then a result class uses `@Relation` with `associateBy = Junction(CrossRef::class)`.
:::

## Transactions and threading

How to group writes atomically, which threads Room uses, and why suspend DAO calls are main-safe.

:::tldr
- `withTransaction { }` (or a `@Transaction` DAO method) makes several operations all-or-nothing and much faster.
- `suspend` and `Flow` DAO methods are main-safe; blocking DAO methods run on the caller thread and are banned on main.
- SQLite allows one writer at a time; keep transactions short and never call the network inside one.
:::

### Transactions

A transaction groups several operations so they all succeed or all fail. It also makes many writes faster, because SQLite commits to disk once instead of once per statement.

```kotlin
suspend fun replaceAll(notes: List<NoteEntity>) {
    db.withTransaction {
        noteDao.deleteAll()
        noteDao.insertAll(notes)
    }
}
```

You can also put the transaction in the DAO itself, using an abstract class.

```kotlin
@Dao
abstract class NoteDao {
    @Query("DELETE FROM notes") abstract suspend fun deleteAll()
    @Insert abstract suspend fun insertAll(notes: List<NoteEntity>)

    @Transaction
    open suspend fun replaceAll(notes: List<NoteEntity>) {
        deleteAll()
        insertAll(notes)
    }
}
```

- Any exception inside the block rolls back the whole transaction.
- `withTransaction` is coroutine-aware. DAO calls inside it join the same transaction even though they suspend.
- Keep transactions short. A long transaction blocks every other writer.
- Never make network calls inside a transaction. Fetch first, then write.
- The blocking `db.runInTransaction { }` exists too, for non-coroutine code off the main thread.

> **Pitfall:** Launching a new coroutine inside `withTransaction`, for example with `launch` on another scope, escapes the transaction. Keep every DAO call in the block's own coroutine.

### The main-thread check

Room throws `IllegalStateException: Cannot access database on the main thread` when a blocking DAO call runs on the main thread. This protects you from jank and ANRs.

```kotlin
// Only for tests or throwaway prototypes
Room.databaseBuilder(context, AppDatabase::class.java, "app.db")
    .allowMainThreadQueries()
    .build()
```

Never ship `allowMainThreadQueries()` in production code.

### How suspend and Flow DAOs dispatch

- A `suspend` DAO function is **main-safe**. You can call it from `viewModelScope` on `Dispatchers.Main`. Room runs the work on its own background threads and resumes you on your context.
- You do not need `withContext(Dispatchers.IO)` around Room suspend calls. It is harmless but redundant.
- A `Flow` DAO function also runs its query in the background.
- Blocking DAO functions (not `suspend`, not `Flow`) run on the caller's thread. That is why the main-thread check exists.

### Executors and coroutine context

On Android, Room has a **query executor** and a **transaction executor**. By default both use a shared background pool. You can replace them.

```kotlin
Room.databaseBuilder(context, AppDatabase::class.java, "app.db")
    .setQueryExecutor(myQueryExecutor)
    .setTransactionExecutor(myTransactionExecutor)
    .build()
```

Since Room 2.7 you can instead set a coroutine context. This is the usual choice in KMP code.

```kotlin
builder.setQueryCoroutineContext(Dispatchers.IO)
```

> **Under the hood:** SQLite allows only one writer at a time. Room serializes write transactions on a single writer connection. With WAL mode on, readers use other connections and keep reading while a write is in progress.

> **Note:** Room 2.7 also added connection-level APIs, `useReaderConnection` and `useWriterConnection`, that work with the driver API and KMP. Most app code still uses DAOs plus `withTransaction`.

:::deeper Why batching is so much faster
Outside a transaction, every statement is its own implicit transaction. Each one must make its change durable on disk before returning.

```kotlin
// Slow: 1,000 implicit transactions, 1,000 commits
items.forEach { dao.insert(it) }

// Fast: one transaction, one commit
dao.insertAll(items)
```

A generated `insertAll` already wraps its loop in one transaction. If you need several different DAO calls in one batch, wrap them in `withTransaction`. The same rule cuts invalidation work: observers are notified once per transaction, not once per row.
:::

:::check
Q: Inside `withTransaction`, you call `deleteAll()`, then the API, then `insertAll()`. The API call throws. What is in the table afterwards, and what is the design problem?
A: The transaction rolls back, so the old rows are still there. The problem is holding the write lock during a slow network call; fetch first, then run a short transaction.
Q: A ViewModel calls a blocking (non-suspend) DAO method inside `viewModelScope.launch { }`. What happens?
A: `viewModelScope` runs on `Dispatchers.Main` by default, so the call runs on the main thread and Room throws "Cannot access database on the main thread". Make the DAO method `suspend`.
Q: Interview: Do you need `withContext(Dispatchers.IO)` around Room suspend functions?
A: No. Suspend DAO functions are main-safe: Room runs the query on its own executor or coroutine context and resumes the caller. Only blocking DAO functions run on the caller's thread.
:::

## Migrations

How to change the schema without losing user data: manual migrations, auto-migrations, destructive fallback and migration tests.

:::tldr
- Every schema change needs a version bump plus a path from each old version, or Room throws on open.
- `AutoMigration` handles simple changes from exported schemas; a manual `Migration` handles data transforms.
- Destructive fallback is only for pure caches; test every migration with `MigrationTestHelper`.
:::

### How Room decides

The schema version lives in the database file. On open, Room compares it with `@Database(version = ...)`.

- Same version, same schema hash: open normally.
- Same version, different hash: you changed an entity without bumping the version. Room throws "Room cannot verify the data integrity".
- Higher version: Room looks for a chain of migrations. If none exists, it throws, unless destructive fallback is on.

### Manual Migration

```kotlin
val MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
    }
}

val MIGRATION_2_3 = object : Migration(2, 3) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("CREATE INDEX IF NOT EXISTS index_notes_pinned ON notes(pinned)")
    }
}

Room.databaseBuilder(context, AppDatabase::class.java, "app.db")
    .addMigrations(MIGRATION_1_2, MIGRATION_2_3)
    .build()
```

- Room chains migrations. A user on version 1 runs 1 to 2, then 2 to 3.
- You can also add a direct `Migration(1, 3)`; Room prefers the shortest path.
- After migrating, Room validates the result against the expected schema. A mismatch throws "Migration didn't properly handle".

SQLite's `ALTER TABLE` is limited. To change a column type or a constraint, recreate the table: create `notes_new`, copy rows with `INSERT INTO ... SELECT`, drop `notes`, and rename `notes_new` to `notes`. Copy the exact `CREATE TABLE` from the new version's schema JSON so validation passes.

### AutoMigration

For simple changes, Room generates the migration by diffing two exported schema files. This needs `exportSchema = true` and the old schema JSON in your repo.

```kotlin
@Database(
    entities = [NoteEntity::class],
    version = 3,
    autoMigrations = [
        AutoMigration(from = 1, to = 2),
        AutoMigration(from = 2, to = 3, spec = AppDatabase.Migration2To3::class),
    ],
)
abstract class AppDatabase : RoomDatabase() {
    @RenameColumn(tableName = "notes", fromColumnName = "text", toColumnName = "body")
    class Migration2To3 : AutoMigrationSpec
}
```

- New tables and new columns are handled automatically. A new non-null column needs a `defaultValue`.
- Renames and deletes are ambiguous (rename, or drop plus add?), so you declare them in a spec with `@RenameColumn`, `@RenameTable`, `@DeleteColumn` or `@DeleteTable`.
- A spec can override `onPostMigrate` to run extra SQL, such as a backfill.
- You can mix auto and manual migrations. For the same versions, the manual one wins.

### Destructive fallback

```kotlin
Room.databaseBuilder(context, AppDatabase::class.java, "app.db")
    .fallbackToDestructiveMigration(dropAllTables = true)
    .build()
```

If no migration path exists, Room drops all tables and recreates them. Every row is gone.

- Acceptable for a pure cache that can be fetched again.
- Unacceptable for user-created data: drafts, notes, offline edits, unsynced changes.
- `fallbackToDestructiveMigrationFrom(...)` limits it to specific old versions.
- `fallbackToDestructiveMigrationOnDowngrade(...)` covers users who install an older build.

> **Pitfall:** Teams add destructive fallback "just for development" and ship it. The first time a migration is missing in production, users silently lose their data.

:::deeper Testing migrations
`MigrationTestHelper` (from `room-testing`) builds a database at an old version from the exported schema, runs your migration, and validates the result.

```kotlin
@get:Rule
val helper = MigrationTestHelper(
    InstrumentationRegistry.getInstrumentation(),
    AppDatabase::class.java,
)

@Test
fun migrate1To2_keepsData() {
    helper.createDatabase("test.db", 1).use { db ->
        db.execSQL("INSERT INTO notes (id, title) VALUES (1, 'hi')")
    }
    val db = helper.runMigrationsAndValidate("test.db", 2, true, MIGRATION_1_2)
    db.query("SELECT pinned FROM notes WHERE id = 1").use { c ->
        assertTrue(c.moveToFirst())
        assertEquals(0, c.getInt(0))
    }
}
```

The helper reads schema JSON from the test assets, so add the folder there.

```kotlin
android {
    sourceSets["androidTest"].assets.srcDir("$projectDir/schemas")
}
```

> **Tip:** Also write one test that migrates from version 1 to the latest, then opens the database with Room and runs a real query. It catches chain gaps and validation errors in one go.
:::

:::check
Q: You add a field to an entity, ship the app, and forget to bump the version. What do upgrading users see?
A: A crash on open with "Room cannot verify the data integrity". The stored schema hash no longer matches, but the version says no migration is needed.
Q: An auto-migration renames `text` to `body`, but you did not add a spec. What does Room do?
A: It cannot tell a rename from a drop plus add, so the build fails and asks you for an `AutoMigrationSpec` with `@RenameColumn` or `@DeleteColumn`.
Q: Interview: When would you use AutoMigration and when a manual Migration?
A: AutoMigration for simple, unambiguous changes like a new table or a column with a default, plus renames and deletes declared in a spec. Manual migration for data transforms, type changes, splitting tables, or anything needing custom SQL.
:::

## Beyond the basics

Useful Room features you will meet in real apps: pre-populated databases, full-text search, WAL, multiple instances and the Database Inspector.

:::tldr
- `createFromAsset` copies a shipped database on first open; its schema must match your entities.
- `@Fts4` tables plus `MATCH` give fast text search; WAL lets reads continue during writes.
- One database instance per file per process; use multi-instance invalidation across processes.
:::

### Pre-populating a database

Ship a ready-made database file and let Room copy it on first open.

```kotlin
Room.databaseBuilder(context, AppDatabase::class.java, "app.db")
    .createFromAsset("database/seed.db")
    .build()
```

- `createFromFile(file)` does the same from a file path.
- Copying happens only when the database does not exist yet.
- The asset's schema must match your entities exactly, or validation fails.
- If the asset has an older version, Room runs your migrations on the copy.

For a few seed rows, a `RoomDatabase.Callback` with `onCreate` that inserts them with SQL is simpler.

### Full-text search with FTS4

For fast text search, Room supports SQLite's FTS virtual tables.

```kotlin
@Fts4(contentEntity = NoteEntity::class)
@Entity(tableName = "notes_fts")
data class NoteFts(val title: String, val body: String)

@Query("""
    SELECT notes.* FROM notes
    JOIN notes_fts ON notes.rowid = notes_fts.rowid
    WHERE notes_fts MATCH :query
""")
fun search(query: String): Flow<List<NoteEntity>>
```

- `MATCH` uses an inverted index of words, so it is far faster than `LIKE '%x%'` on big tables.
- `contentEntity` makes it an external content table. It reads text from `notes` instead of storing it twice, and Room keeps it in sync with triggers.
- FTS tables use the implicit `rowid` as their key.
- The query syntax supports prefix search, such as `kot*`.

### WAL mode basics

SQLite can use a rollback journal or **write-ahead logging (WAL)**. In WAL mode, writes go to a separate log file first and are merged into the main file later.

- Readers do not block the writer, and the writer does not block readers.
- Writes are often faster because they are sequential appends.
- You will see `app.db-wal` and `app.db-shm` next to `app.db`.

Room's default `JournalMode.AUTOMATIC` picks WAL, except on low-RAM devices. You can force a mode with `setJournalMode(...)`.

> **Pitfall:** When backing up or copying the database, close it or checkpoint first, or copy all three files. Copying only `app.db` can lose recent writes still in the WAL file.

Deep SQLite internals, like pages, B-trees, checkpoints and the query planner, are a Level 3 topic. For now: WAL exists, it is usually on, and it allows reads during writes.

### One instance per process

Room must be a **singleton** per database file within a process.

- Each `RoomDatabase` instance has its own connections and its own `InvalidationTracker`.
- Two instances on the same file do not see each other's writes, so Flows from one never update after writes through the other.
- Two instances also waste memory and can cause "database is locked" errors.

If you truly use the database from several processes, for example a separate `:sync` process, call `enableMultiInstanceInvalidation()` on the builder in every process. Still keep one instance per process.

> **Interview:** "Why must the database be a singleton?" Because invalidation, connection pooling and write serialization all live in the instance. Two instances on one file break observation and fight over locks.

### Database Inspector

Android Studio's **App Inspection** window lets you browse tables, run SQL, and watch live updates in a running debuggable app on API 26+. A run icon next to each `@Query` in the editor runs that DAO query directly. It is the fastest way to answer "why is my Flow empty".

:::deeper Database views
`@DatabaseView` defines a saved SELECT that you can query like a table. It is handy for reusing a complex JOIN or a filter.

```kotlin
@DatabaseView("SELECT * FROM messages WHERE isRead = 0")
data class UnreadMessage(val id: Long, val chatId: Long, val text: String)
```

List it under `views = [...]` in `@Database`. A Flow that reads the view is invalidated when its underlying tables change. A view is also one way to filter children for a `@Relation`, which cannot filter by itself.
:::

:::check
Q: A user reports that search is slow on 50,000 notes using `LIKE '%term%'`. What do you change, and why does it help?
A: Add an `@Fts4` table with `contentEntity = NoteEntity::class` and query it with `MATCH`. FTS keeps an index of words, while a leading-wildcard `LIKE` must scan every row.
Q: A Hilt module mistakenly builds `AppDatabase` without `@Singleton`. The list screen stops updating after edits on the detail screen. Why?
A: Each injection gets a new instance with its own InvalidationTracker. Writes through the detail screen's instance never notify observers on the list screen's instance.
Q: Interview: What is WAL mode and why does it matter for an app?
A: Write-ahead logging writes changes to a separate log before merging them into the main file. Readers and the writer do not block each other, so UI reads stay fast during background sync. Room enables it automatically on most devices.
:::

## Room in the architecture

Where Room sits in a clean app: provided by Hilt, hidden behind a repository, and used as the single source of truth for offline-first.

:::tldr
- Provide one `@Singleton` database with Hilt and inject DAOs into repositories, not ViewModels.
- Offline-first: the UI reads only from Room; the network writes into Room and the Flow delivers the change.
- Keep entities as a storage model; map DTO to entity and entity to domain at the edges.
:::

### Providing Room with Hilt

```kotlin
@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {

    @Provides
    @Singleton
    fun provideDatabase(@ApplicationContext context: Context): AppDatabase =
        Room.databaseBuilder(context, AppDatabase::class.java, "app.db")
            .addMigrations(MIGRATION_1_2, MIGRATION_2_3)
            .build()

    @Provides
    fun provideNoteDao(db: AppDatabase): NoteDao = db.noteDao()
}
```

- The database must be `@Singleton`. DAOs do not need a scope; the generated database caches each DAO instance anyway.
- Inject DAOs into repositories. The ViewModel should not know Room exists.
- In tests, replace this module with one that builds an in-memory database.

### Room as the single source of truth

In an offline-first app, the UI reads **only** from the database. The network never pushes data straight to the UI. It writes into Room, and Room's Flow delivers the change.

```text
UI <- ViewModel (StateFlow) <- Repository.observe() <- Room Flow
                                     |
                                 refresh()
                                     |
                         Network -> Room (upsert in transaction)
```

```kotlin
class NotesRepository(
    private val api: NotesApi,
    private val dao: NoteDao,
    private val db: AppDatabase,
) {
    fun observeNotes(): Flow<List<Note>> =
        dao.observeAll().map { list -> list.map { it.toDomain() } }

    suspend fun refresh() {
        val remote = api.fetchNotes()                // network first
        db.withTransaction {                         // then a short write
            dao.deleteAllSynced()
            dao.upsert(remote.map { it.toEntity() })
        }
    }
}
```

Why this design works:

- The screen shows cached data instantly, even offline.
- A refresh updates every screen that observes the same table, automatically.
- There is one place to reason about the current state.
- A network error does not wipe the screen. You show cached data plus an error message.

### Writes in offline-first

For user edits, write locally first, then sync.

```kotlin
suspend fun editTitle(id: String, title: String) {
    dao.updateTitle(id, title, syncState = SyncState.PENDING)
    syncScheduler.enqueue()   // for example a WorkManager job
}
```

- Keep a `syncState` or `isDirty` column so the sync worker knows what to push.
- When the server confirms, mark the rows as synced.
- Do not let a background `refresh()` overwrite pending local edits. Skip rows marked pending, or merge them.

> **Pitfall:** The `refresh()` above deletes only synced rows on purpose. A plain "delete all, insert remote" would throw away the user's unsynced edits.

### Keep layers separate

- Entities are a **storage model**. Do not use them directly as UI models or network DTOs.
- Map `Dto -> Entity` on the way in and `Entity -> Domain` on the way out.
- Then a schema change does not touch the UI, and an API rename does not force a migration.

> **Tip:** Put the mappers next to the data layer, as extension functions like `NoteDto.toEntity()` and `NoteEntity.toDomain()`. They are tiny, pure and easy to unit test.

:::deeper Where the database opens
Building the database object is cheap, but the first query opens the file. That is when Room creates tables, runs migrations and validates the schema. On a large migration it can take a noticeable time.

- Room does this work on its background threads when the first call is a `suspend` or `Flow` call, so the UI stays responsive.
- If startup must show data fast, trigger a cheap read early in a background coroutine so the open cost is paid before the first screen needs it.
- Never force the open from `Application.onCreate` on the main thread.
:::

:::check
Q: The repository returns `Flow<List<NoteEntity>>` straight to the UI. Later the backend renames a field and the team changes the entity to match. What breaks?
A: The schema changes, so you now need a migration, and every UI file that used the entity must change too. Separate DTO, entity and domain models keep each change local.
Q: In an offline-first app, the user edits a note offline and a periodic refresh runs before the sync worker. How do you avoid losing the edit?
A: Mark the edit with a pending sync state and make the refresh skip or merge pending rows instead of overwriting them. Only mark the row synced when the server confirms.
Q: Interview: Describe Room's role in an offline-first architecture.
A: Room is the single source of truth. The UI observes it through the repository as a Flow, the network layer only writes into Room inside a transaction, and the Flow pushes changes to every screen. Local edits go to Room first with a pending flag and sync later.
:::

## Testing Room

How to test DAOs, Flows, repositories and migrations against a real database instead of mocks.

:::tldr
- Use `Room.inMemoryDatabaseBuilder` so every test starts with a fresh, fast database.
- Test Flow emissions with Turbine: assert the first item, write, then assert the next.
- Test SQL with a real database, not a mocked DAO; run migration tests on a device for accuracy.
:::

### In-memory database

An in-memory database lives in RAM and disappears when closed. It is fast and every test starts clean.

```kotlin
class NoteDaoTest {
    private lateinit var db: AppDatabase
    private lateinit var dao: NoteDao

    @Before fun setUp() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            AppDatabase::class.java,
        ).allowMainThreadQueries().build()
        dao = db.noteDao()
    }

    @After fun tearDown() = db.close()
}
```

`allowMainThreadQueries()` is fine here, because tests often call blocking helpers directly.

### A DAO test

```kotlin
@Test fun upsert_updatesExistingRow() = runTest {
    dao.upsert(listOf(NoteEntity(id = 1, title = "a", body = "")))
    dao.upsert(listOf(NoteEntity(id = 1, title = "b", body = "")))

    val all = dao.observeAll().first()
    assertEquals(listOf("b"), all.map { it.title })
}
```

Each test follows the same shape: arrange rows, act through the DAO, assert with a query. Test the cases where SQL can be subtly wrong: filters, ordering, joins, relations and conflicts.

### Testing Flow emissions

Use Turbine, or collect into a list, to check that a write causes a new emission.

```kotlin
@Test fun observe_reEmitsOnInsert() = runTest {
    dao.observeAll().test {
        assertEquals(emptyList<NoteEntity>(), awaitItem())
        dao.upsert(listOf(NoteEntity(1, "a", "")))
        assertEquals(1, awaitItem().size)
        cancelAndIgnoreRemainingEvents()
    }
}
```

> **Note:** Room's invalidation runs on Room's own background threads, not on the test's virtual clock. Turbine's `awaitItem` waits in real time, so this works. If an emission seems missing, check that the write touched the observed table and that `distinctUntilChanged` did not drop it.

### Where tests run

| Option | Where it runs | Pros | Cons |
|---|---|---|---|
| Instrumented (androidTest) | Device or emulator | Real Android SQLite, most accurate | Slow, needs a device |
| Robolectric (test) | JVM | Fast, easy in CI | SQLite version may differ from devices |
| Bundled driver on JVM | JVM | Same SQLite everywhere if you ship it | Needs the driver API setup |

A common split: DAO tests on Robolectric for speed, migration tests instrumented for accuracy.

### What to test

- DAO queries with tricky SQL: filters, ordering, joins, relations.
- Conflict behavior: upsert, ignore, and what happens to children.
- Every migration, with real data in the old version.
- Repository logic with a real in-memory database rather than a mocked DAO.

> **Pitfall:** Mocking a DAO tests your mock, not your SQL. A wrong `WHERE` clause passes every mocked test. Use a real in-memory database for anything that touches queries.

### Hilt test setup

With Hilt, replace the production module in tests.

```kotlin
@Module
@TestInstallIn(components = [SingletonComponent::class], replaces = [DatabaseModule::class])
object TestDatabaseModule {
    @Provides @Singleton
    fun db(@ApplicationContext c: Context): AppDatabase =
        Room.inMemoryDatabaseBuilder(c, AppDatabase::class.java).build()

    @Provides fun noteDao(db: AppDatabase): NoteDao = db.noteDao()
}
```

Every test class that uses Hilt now gets a fresh in-memory database, with the same DAO wiring as production.

:::check
Q: A repository test mocks `NoteDao.search()` to return two notes, and it passes. In production, search returns nothing. What did the test miss?
A: It never ran the SQL, so a bug in the query (for example a wrong `LIKE` pattern) was invisible. Test search against a real in-memory database.
Q: A Turbine test inserts a row but the second `awaitItem()` times out. Name two likely causes.
A: The write went to a different table or a different database instance than the one observed, or the Flow has `distinctUntilChanged()` and the new result equals the old one.
Q: Interview: How do you test a Room-based repository and its migrations?
A: Use an in-memory database for DAO and repository tests, asserting Flow emissions with Turbine. For migrations, use `MigrationTestHelper` with exported schemas: create the old version with real data, run and validate the migration, then query the data, ideally across the full chain.
:::

## Performance and pitfalls

The habits that keep Room fast and the mistakes that show up again and again in reviews and interviews.

:::tldr
- Index what you filter, join and sort on; select only needed columns; page long lists.
- Batch writes in one transaction and avoid N+1 queries.
- Most Room bugs are a missing `@Transaction`, a second instance, a missing migration, or `REPLACE` with cascades.
:::

### Performance tips

- **Index** columns used in `WHERE`, `JOIN` and `ORDER BY`. Check with `EXPLAIN QUERY PLAN` in the Database Inspector.
- **Avoid `SELECT *`** for list screens. Project into a small data class.
- **Batch writes** in one transaction. One `insertAll` of 1,000 rows is far faster than 1,000 single inserts.
- **Use `LIMIT`** and Paging for long lists. Never load an unbounded table into memory.
- **Keep blobs out.** Store large files on disk and keep only a path.
- **Narrow Flows.** Observe the smallest query that serves the screen, since any table change re-runs it.
- **`distinctUntilChanged()`** on Flows that feed expensive mapping or UI work.
- **Avoid N+1 queries.** Do not loop and call a DAO per item.

### N+1 queries

```kotlin
// Slow: one query per post
val result = posts.map { post -> post to commentDao.forPost(post.id) }

// Fast: one query for all children
val comments = commentDao.forPosts(posts.map { it.id })   // WHERE postId IN (:ids)
val byPost = comments.groupBy { it.postId }
```

`@Relation` does this batching for you. It loads children with one `IN (...)` query per relation, not one per parent.

### Reading a query plan

```sql
EXPLAIN QUERY PLAN
SELECT * FROM notes WHERE folderId = 3 ORDER BY updatedAt DESC;
```

If the result says `SCAN notes`, SQLite reads every row. With an index on `(folderId, updatedAt)` it says `SEARCH notes USING INDEX`, which reads only matching rows, already in order. Deeper query planner details are a Level 3 topic.

### Common pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| REPLACE with cascading foreign keys | Child rows vanish | Use @Upsert |
| @Relation without @Transaction | Rare mismatched parents and children | Add @Transaction |
| Two database instances | Flows stop updating, lock errors | One @Singleton instance |
| Destructive fallback in production | Users lose data on upgrade | Real migrations, tested |
| Entity changed, version not bumped | Crash: cannot verify data integrity | Bump version, add migration |
| schemas folder not committed | Auto-migrations cannot be generated | Commit schemas |
| Flow DAO marked suspend | Pointless suspension, confusing API | Plain fun returning Flow |
| Queryable list stored as JSON | Slow LIKE searches | Separate table or junction |
| Entity used as API DTO | Server rename forces a migration | Separate DTO and mapper |
| Network call inside withTransaction | Writers blocked for seconds | Fetch first, then write |

> **Pitfall:** Expecting a Flow to emit only when "my" row changes. Invalidation is per table, so design for repeated emissions.

### A quick review checklist

When you review a Room pull request, ask:

1. Does the schema JSON diff match the intended change, with a version bump and a migration?
2. Is there a migration test for the new version?
3. Do new filters or sorts have an index?
4. Do relation queries have `@Transaction`?
5. Are multi-step writes inside one transaction, with no network call inside?
6. Do list screens use a projection or Paging instead of `SELECT *` on a big table?

> **Interview:** "How would you speed up a slow Room query on a big table?" Check the query plan, add an index on the filtered and sorted columns, select only needed columns, add `LIMIT` or Paging, remove N+1 loops, and use FTS instead of `LIKE '%x%'` for text search.

:::check
Q: A screen shows 20 folders, each with its note count, by calling `noteDao.countIn(folderId)` in a loop. How do you fix it?
A: Use one grouped query, such as `SELECT folderId, COUNT(*) AS count FROM notes GROUP BY folderId`, into a small data class. One query replaces 20.
Q: `EXPLAIN QUERY PLAN` shows `SCAN notes` for `WHERE folderId = :id ORDER BY updatedAt DESC`. What index do you add?
A: A composite index on `(folderId, updatedAt)`. It finds the folder's rows and returns them already sorted, so SQLite avoids both the scan and a separate sort.
Q: Interview: Name three Room mistakes that cause data loss or silent bugs in production.
A: Shipping destructive fallback for user data, using `REPLACE` on parents with cascading children, and creating two database instances so Flows stop updating. Forgetting `@Transaction` on relation queries is a close fourth.
:::

## Review and cheat sheet

One screen of everything in this topic, plus practice to lock it in.

:::tldr
- Skim the cheat sheet the night before an interview; each row maps to an earlier lesson.
- Do the exercises: each one forces you to explain a choice, not just write code.
- When unsure what Room does, read the generated `_Impl` class.
:::

### Cheat sheet

| Need | Use |
|---|---|
| Table | @Entity with @PrimaryKey |
| Rename column | @ColumnInfo(name = ...) |
| Skip a field | @Ignore |
| Flatten an object | @Embedded(prefix = ...) |
| Custom type | @TypeConverter + @TypeConverters |
| Converter with dependencies | @ProvidedTypeConverter + addTypeConverter |
| Insert or update | @Upsert |
| Insert if missing | @Insert(onConflict = IGNORE) |
| One-shot read | suspend fun with @Query |
| Observe | fun returning Flow, not suspend |
| Paging | PagingSource from @Query + room-paging |
| Relations | @Embedded + @Relation + @Transaction |
| Many-to-many | Junction(CrossRef::class) |
| Atomic multi-step write | db.withTransaction { } |
| Schema change | Bump version + Migration or AutoMigration |
| Rename in auto-migration | AutoMigrationSpec + @RenameColumn |
| Seed data | createFromAsset |
| Text search | @Fts4 + MATCH |
| Tests | inMemoryDatabaseBuilder, MigrationTestHelper |
| Multi-process | enableMultiInstanceInvalidation |
| Build setup | KSP + androidx.room plugin + schemaDirectory |

### Rules to remember

- One database instance per process, provided as a singleton.
- Room is the source of truth; the network writes into Room.
- Invalidation is per table, after the transaction commits.
- Suspend DAOs are main-safe. Flow DAOs are not suspend.
- Batch writes in a transaction. Index what you filter and sort.
- Export schemas, commit them, and test every migration.
- Never ship destructive fallback for user-created data.

### Practice exercises

1. **Notes with tags.** Build `NoteEntity`, `TagEntity` and `NoteTagCrossRef`. Write a DAO that returns `Flow<List<NoteWithTags>>` and a query for all notes with a given tag. Explain why tags are not stored as JSON.
2. **Migration chain.** Add a `pinned` column in version 2 with AutoMigration, then rename `body` to `content` in version 3 with an `AutoMigrationSpec`. Write a `MigrationTestHelper` test from 1 to 3 with real data.
3. **Offline-first repository.** `observeArticles()` returns a Room Flow and `refresh()` fetches from a fake API and upserts in one transaction. Prove with a test that a refresh does not overwrite articles with pending local edits.
4. **Table-level invalidation.** Write a test that shows a Flow from `observeById(3)` re-emits when note 7 changes. Add `distinctUntilChanged()` and show the duplicate is gone.
5. **Measure it.** Insert 10,000 rows one by one, then with `insertAll`, and time both. Then add an FTS4 table and compare `MATCH` with `LIKE '%term%'`.

### References

- [Save data in a local database using Room](https://developer.android.com/training/data-storage/room)
- [Define data using Room entities](https://developer.android.com/training/data-storage/room/defining-data)
- [Access data using Room DAOs](https://developer.android.com/training/data-storage/room/accessing-data)
- [Define relationships between objects](https://developer.android.com/training/data-storage/room/relationships)
- [Write asynchronous DAO queries](https://developer.android.com/training/data-storage/room/async-queries)
- [Referencing complex data using Room](https://developer.android.com/training/data-storage/room/referencing-data)
- [Migrate your Room database](https://developer.android.com/training/data-storage/room/migrating-db-versions)
- [Test and debug your database](https://developer.android.com/training/data-storage/room/testing-db)
- [Prepopulate your Room database](https://developer.android.com/training/data-storage/room/prepopulate)
- [Room (Kotlin Multiplatform)](https://developer.android.com/kotlin/multiplatform/room)
- [Build an offline-first app](https://developer.android.com/topic/architecture/data-layer/offline-first)
- [Inspect databases with Database Inspector](https://developer.android.com/studio/inspect/database)
- [Room release notes](https://developer.android.com/jetpack/androidx/releases/room)

:::check
Q: A list screen observes `SELECT * FROM posts` with `@Relation` comments, and scrolling stutters on every sync. Name two changes that help.
A: Project only the columns the list needs and page the list with a `PagingSource`, or add `distinctUntilChanged()` so identical results do not re-render. Also make the sync write in one transaction so observers are notified once.
Q: You must change a column from TEXT to INTEGER and convert existing values. AutoMigration or manual Migration?
A: Manual. SQLite cannot change a column type with `ALTER TABLE`, so you recreate the table and convert values with SQL, which AutoMigration cannot infer.
Q: Interview: Walk through what happens from `dao.upsert(note)` to the UI showing the new note.
A: The suspend call runs on Room's background thread inside a transaction; the table's trigger marks `notes` as changed. After commit, the InvalidationTracker notifies the observing Flow, which re-runs its query and emits; the ViewModel's StateFlow updates and the UI recomposes.
:::
