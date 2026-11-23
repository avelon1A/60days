Room is the Jetpack library for storing structured data in a local SQLite database. It gives you compile-time checked SQL, Kotlin-friendly APIs, and observable queries that fit naturally into coroutines and Flow. These notes go from Gradle setup to migrations, relations, offline-first repositories and testing, with the details senior Android interviews like to probe.

## Why Room

Android has shipped SQLite since day one. You could always use `SQLiteOpenHelper` and `Cursor` directly. Room is a thin layer on top of that same SQLite. It does not replace the database engine. It replaces the boilerplate and the bugs.

### Problems with raw SQLite

- SQL lives in strings. A typo in a column name fails only at runtime, often in production.
- You map every `Cursor` row to an object by hand. That is long, repetitive and easy to get wrong.
- Schema changes need hand-written upgrade code with no help in testing it.
- No built-in way to observe data. You must notify the UI yourself after every write.
- Easy to run queries on the main thread and cause jank or ANRs.

### What Room adds

- **Compile-time SQL verification.** Room parses your `@Query` strings during the build. A wrong table or column name is a build error.
- **Generated mapping code.** No manual `Cursor` reading.
- **Observable queries.** Return a `Flow` and the query re-runs when its tables change.
- **Coroutines support.** `suspend` DAO functions run off the main thread for you.
- **Migration tooling.** Exported schema files, auto-migrations, and a test helper.
- **Main-thread guard.** Room throws if you query on the main thread (unless you opt out).
- **Kotlin Multiplatform.** Since Room 2.7, the same database code can run on Android, iOS, JVM desktop and more.

| Concern | Raw SQLite | Room |
|---|---|---|
| SQL errors | Runtime crash | Build error |
| Row mapping | Manual Cursor code | Generated |
| Observing changes | DIY | Flow, LiveData, PagingSource |
| Threading | Your problem | suspend + main-thread check |
| Migrations | Hand-written, untested | Migration, AutoMigration, test helper |
| Multiplatform | No | Yes, from 2.7 |

> **Interview:** Room is an abstraction over SQLite, not a different database. Anything SQLite can do, you can still do in a `@Query` or through `SupportSQLiteDatabase` / the driver connection.

### When not to use Room

- Simple key-value settings. Use DataStore.
- Large binary files (images, video). Store them as files and keep only the path in Room.
- Pure caches with no querying needs. An in-memory map or a disk cache may be enough.

## Setup

Room uses an annotation processor to generate code. Today that processor runs on **KSP** (Kotlin Symbol Processing). kapt still works on older setups but is in maintenance mode and slower. New projects should use KSP.

### Gradle with KSP

```kotlin
// libs.versions.toml (versions shown are examples, check the latest)
// room = "2.7.2"
// ksp = "<matches your Kotlin version>"

// build.gradle.kts (module)
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.devtools.ksp")
    id("androidx.room") // Room Gradle plugin
}

dependencies {
    implementation("androidx.room:room-runtime:$roomVersion")
    implementation("androidx.room:room-ktx:$roomVersion")
    ksp("androidx.room:room-compiler:$roomVersion")

    // Optional
    implementation("androidx.room:room-paging:$roomVersion")
    testImplementation("androidx.room:room-testing:$roomVersion")
}
```

### Schema export directory

Room can write a JSON file describing your schema for every database version. You need these files for auto-migrations and for migration tests. Commit them to version control.

```kotlin
// With the Room Gradle plugin
room {
    schemaDirectory("$projectDir/schemas")
}
```

The plugin wires the directory into KSP correctly and handles build caching. Without the plugin, you pass a KSP argument instead.

```kotlin
ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}
```

> **Tip:** Treat `schemas/` like source code. Review schema JSON diffs in pull requests. A surprising diff usually means you forgot a migration.

### Useful processor options

- `room.generateKotlin` makes Room generate Kotlin instead of Java. With KSP this is the default in recent versions.
- `room.incremental` enables incremental processing (on by default with KSP).
- `room.expandProjection` rewrites `SELECT *` to only the columns your return type needs.

### Kotlin Multiplatform in one paragraph

From Room 2.7, Room supports KMP. You declare the database in common code. You plug in a `SQLiteDriver`, for example `BundledSQLiteDriver` from `androidx.sqlite:sqlite-bundled`, which ships its own SQLite build so every platform uses the same SQLite version. On non-Android targets the database class needs a `@ConstructedBy` annotation pointing at an `expect object` that implements `RoomDatabaseConstructor`; Room generates the `actual`. The rest of this guide applies to both Android-only and KMP code, except where it mentions `SupportSQLiteDatabase` or `Context`, which are Android-only.

## The Three Building Blocks

Every Room setup has three parts.

1. **Entity**: a class that maps to a table.
2. **DAO** (Data Access Object): an interface with your queries.
3. **Database**: an abstract class that lists entities and exposes DAOs.

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
    "app.db"
).build()
```

Use the **application** context. An Activity context would leak.

### What the processor generates

At build time, Room generates:

- `AppDatabase_Impl`: creates tables, holds the `InvalidationTracker`, and returns DAO instances.
- `UserDao_Impl`: the real code for each DAO method. It prepares SQL statements, binds parameters, reads rows and builds your objects.
- Schema JSON in your schema directory, if export is on.

You can find the generated files under `build/generated/ksp/`. Reading one `_Impl` class once is a great way to demystify Room.

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

> **Under the hood:** Compile-time verification works because Room knows your full schema from the `@Entity` classes. It parses each `@Query` against that schema and checks that tables, columns, parameters and return types line up.

### What gets checked at compile time

- Table and column names in `@Query`.
- Bind parameters (`:id`) match function parameters.
- The return type can be built from the selected columns.
- Missing columns produce a warning (or error) about the cursor mismatch.
- A `@Relation` points at real columns.

What is **not** checked: query performance, logic bugs, and anything built at runtime with `@RawQuery`.

## Entities

An entity is a Kotlin class annotated with `@Entity`. Each property becomes a column unless you say otherwise.

### Primary keys

Every entity needs a primary key.

```kotlin
@Entity(tableName = "notes")
data class NoteEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val title: String,
    val body: String,
)
```

With `autoGenerate = true`, insert the object with `id = 0` and SQLite assigns the next id. `@Insert` returns the new row id as `Long`.

- Use `Long` for auto-generated ids. `Int` works but can overflow on huge tables.
- For data that comes from a server, prefer the **server id** as the primary key. That makes upserts trivial.
- For client-created items that sync later, many teams use a UUID string as the key.

### Composite keys

When the key is a combination of columns, declare it on the entity.

```kotlin
@Entity(
    tableName = "playlist_song",
    primaryKeys = ["playlistId", "songId"]
)
data class PlaylistSongCrossRef(
    val playlistId: Long,
    val songId: Long,
)
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
    @Ignore val isOnSale: Boolean = false
}
```

- `@ColumnInfo(name = ...)` renames the SQL column. Your Kotlin name stays clean.
- `defaultValue` matters for migrations and auto-migrations that add columns.
- `@Ignore` tells Room not to store a property.
- Nullable Kotlin types become nullable columns. Non-null types get `NOT NULL`.

> **Pitfall:** Money as `Double` gives rounding errors. Store cents as `Long`, or a decimal string, never a floating point number.

### Indices and unique constraints

An index speeds up lookups and sorting on a column. A unique index also enforces uniqueness.

```kotlin
@Entity(
    tableName = "users",
    indices = [
        Index(value = ["email"], unique = true),
        Index(value = ["last_name", "first_name"]),
    ]
)
data class UserEntity(
    @PrimaryKey val id: String,
    val email: String,
    @ColumnInfo(name = "first_name") val firstName: String,
    @ColumnInfo(name = "last_name") val lastName: String,
)
```

Indexes cost disk space and slow down writes a bit. Add them for columns you filter, join or sort on often. Do not index everything.

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
    indices = [Index("postId")]
)
data class CommentEntity(
    @PrimaryKey val id: Long,
    val postId: Long,
    val text: String,
)
```

- `onDelete = CASCADE` deletes comments when their post is deleted.
- Room warns if the child column has no index. Without it, every parent change scans the child table.
- Foreign keys are optional. Many apps that mirror a server skip them because the server is the source of truth and data may arrive out of order.

### @Embedded

`@Embedded` flattens a nested object's fields into the parent table. There is no separate table.

```kotlin
data class Address(
    val street: String,
    val city: String,
    val zip: String,
)

@Entity(tableName = "customers")
data class CustomerEntity(
    @PrimaryKey val id: String,
    val name: String,
    @Embedded(prefix = "home_") val home: Address,
    @Embedded(prefix = "work_") val work: Address?,
)
```

Columns become `home_street`, `home_city`, `work_street` and so on. The `prefix` avoids name clashes when you embed the same type twice.

> **Note:** If every column of a nullable `@Embedded` object is null in a row, Room gives you `null` for the whole object.

## Type Converters

SQLite stores only a few types: INTEGER, REAL, TEXT, BLOB and NULL. Room maps Kotlin primitives and `String` for you. For anything else, write a `@TypeConverter`.

### Dates and enums

```kotlin
class Converters {
    @TypeConverter
    fun instantToLong(value: Instant?): Long? = value?.toEpochMilli()

    @TypeConverter
    fun longToInstant(value: Long?): Instant? = value?.let(Instant::ofEpochMilli)

    @TypeConverter
    fun statusToString(value: OrderStatus): String = value.name

    @TypeConverter
    fun stringToStatus(value: String): OrderStatus = OrderStatus.valueOf(value)
}

@Database(entities = [OrderEntity::class], version = 1)
@TypeConverters(Converters::class)
abstract class AppDatabase : RoomDatabase()
```

- Store timestamps as epoch millis (`Long`). They sort and compare correctly in SQL.
- Room has built-in enum support: it stores the enum name as TEXT. A custom converter gives you control, for example a stable code instead of the name.
- `@TypeConverters` can be placed on the database, an entity, a DAO, a method or a field. Narrower scope wins.

> **Pitfall:** Storing enums by `ordinal` breaks the day someone reorders the enum. Store a name or an explicit stable code.

### Lists and why JSON is a smell

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

- You want "all notes with tag X". SQL cannot index inside the JSON blob. You end up with slow `LIKE` queries.
- You want to update one item. You must rewrite the whole blob.
- The JSON format changes. Old rows fail to decode at runtime, which the compiler cannot catch.
- The list grows large. Every read pays the parse cost.

The relational answer is a separate table with a foreign key (one-to-many), or a junction table (many-to-many).

> **Interview:** "When would you store a list as JSON in Room?" Only for small, write-together, never-queried data, such as a cached list of image URLs on an item. Anything you filter, sort or join on belongs in its own table.

### Provided type converters

You can hand Room a converter instance, which is useful when the converter needs dependencies, such as a JSON parser.

```kotlin
@ProvidedTypeConverter
class JsonConverters(private val json: Json) { /* ... */ }

Room.databaseBuilder(context, AppDatabase::class.java, "app.db")
    .addTypeConverter(JsonConverters(json))
    .build()
```

## DAOs

A DAO is an interface (or abstract class) that declares how you read and write data. Room generates the implementation.

### Insert and conflict strategies

```kotlin
@Dao
interface NoteDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(note: NoteEntity): Long

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertAll(notes: List<NoteEntity>): List<Long>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun replace(note: NoteEntity)
}
```

| Strategy | On conflict | Notes |
|---|---|---|
| ABORT | Throws SQLiteConstraintException | Default |
| IGNORE | Skips the row, returns -1 | Good for "insert if missing" |
| REPLACE | Deletes old row, inserts new one | Triggers ON DELETE CASCADE |
| NONE | Same as ABORT in practice | Rarely used |

`ROLLBACK` and `FAIL` exist but are deprecated because they do not behave usefully in Room's transactions.

> **Pitfall:** `REPLACE` is a delete followed by an insert. If child tables have `ON DELETE CASCADE`, replacing a parent silently wipes its children. Use `@Upsert` instead.

### Update, Delete, Upsert

```kotlin
@Dao
interface NoteDao {
    @Update
    suspend fun update(note: NoteEntity): Int   // rows changed

    @Delete
    suspend fun delete(note: NoteEntity): Int   // rows deleted

    @Upsert
    suspend fun upsert(notes: List<NoteEntity>)
}
```

- `@Update` and `@Delete` match rows by primary key only.
- `@Upsert` (Room 2.5+) tries to insert. On a primary key or unique conflict, it updates the existing row instead. No delete, so no cascade surprise.
- All of these accept a single object, a `List`, or `vararg`.

### Partial entities

You can update or insert only some columns using a smaller class.

```kotlin
data class NoteTitle(val id: Long, val title: String)

@Update(entity = NoteEntity::class)
suspend fun updateTitle(update: NoteTitle)
```

### @Query

`@Query` is where most real work happens. Room checks the SQL at compile time.

```kotlin
@Dao
interface NoteDao {
    @Query("SELECT * FROM notes WHERE id = :id")
    suspend fun getById(id: Long): NoteEntity?

    @Query("SELECT * FROM notes WHERE id IN (:ids)")
    suspend fun getByIds(ids: List<Long>): List<NoteEntity>

    @Query("SELECT * FROM notes WHERE title LIKE '%' || :q || '%' ORDER BY updatedAt DESC LIMIT :limit")
    suspend fun search(q: String, limit: Int = 50): List<NoteEntity>

    @Query("DELETE FROM notes WHERE updatedAt < :cutoff")
    suspend fun deleteOlderThan(cutoff: Long): Int

    @Query("SELECT COUNT(*) FROM notes")
    suspend fun count(): Int
}
```

- Bind parameters with `:name`. Never build SQL by string concatenation with user input.
- Collections expand automatically inside `IN (:ids)`.
- `UPDATE` and `DELETE` queries can return `Int` (affected rows).
- Return types can be an entity, any data class whose fields match the columns, a primitive, a `List`, a nullable, a `Flow`, or a `PagingSource`.

### Projections into smaller classes

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

### Multimap return types

Since Room 2.4 a `@Query` with a JOIN can return a `Map` directly.

```kotlin
@Query(
    "SELECT * FROM artists JOIN songs ON artists.id = songs.artistId"
)
fun artistsWithSongs(): Flow<Map<ArtistEntity, List<SongEntity>>>
```

This is an alternative to `@Relation` that lets you write the JOIN yourself.

### Raw queries

When the SQL shape is truly dynamic (for example a filter builder), use `@RawQuery`.

```kotlin
@RawQuery(observedEntities = [NoteEntity::class])
fun observeRaw(query: SupportSQLiteQuery): Flow<List<NoteEntity>>
```

You lose compile-time checking. `observedEntities` tells Room which tables to watch for a `Flow`. Prefer normal `@Query` whenever you can.

### Paging

Add `room-paging` and return a `PagingSource`.

```kotlin
@Query("SELECT * FROM notes ORDER BY updatedAt DESC")
fun pagingSource(): PagingSource<Int, NoteEntity>
```

Room generates a `PagingSource` that loads pages with `LIMIT`/`OFFSET` and invalidates itself when the table changes. For network plus database paging, pair it with a `RemoteMediator`.

## Observable Queries

This is the feature that makes Room the backbone of reactive Android apps. You can skip the Flow basics here; the focus is on how Room drives the stream.

### Return a Flow

```kotlin
@Query("SELECT * FROM notes ORDER BY updatedAt DESC")
fun observeAll(): Flow<List<NoteEntity>>

@Query("SELECT * FROM notes WHERE id = :id")
fun observeById(id: Long): Flow<NoteEntity?>
```

- Do **not** mark a `Flow` DAO function as `suspend`. Creating a `Flow` is cheap; the work happens on collection.
- The Flow emits the current result on collection, then emits again every time an observed table changes.
- Room also supports `LiveData`, and RxJava types via `room-rxjava2` / `room-rxjava3`.

### How the InvalidationTracker works

Room has one `InvalidationTracker` per database.

1. When a table is first observed, Room installs SQLite **triggers** for INSERT, UPDATE and DELETE on it.
2. Each trigger marks the table as changed in a small internal tracking table.
3. After a write transaction ends, Room checks that tracking table to see which tables were touched.
4. It notifies every observer that watches any of those tables.
5. For a `Flow`, that notification makes Room re-run the query and emit the new result.

> **Under the hood:** The tracker works at the **table** level, not the row level. Changing note 7 wakes up a Flow that only observes note 3, because both read the `notes` table.

Consequences you should know:

- A Flow can emit the **same** data again. Add `distinctUntilChanged()` if downstream work is expensive.
- A query that JOINs three tables re-runs if any of the three changes.
- Writes inside one transaction cause one notification, not one per row. Batching helps here too.
- Changes made outside this Room instance (another process, another database object, raw file edits) are not seen unless you enable multi-instance invalidation.

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

With `WhileSubscribed`, Room stops observing when no one collects, which removes the observer from the tracker and saves work in the background.

## Relationships

Room does not let entities hold references to other entities directly. That is on purpose: lazy loading would hide database reads on the main thread. Instead you model relations with intermediate data classes.

### One-to-one

```kotlin
@Entity data class UserEntity(@PrimaryKey val id: Long, val name: String)

@Entity data class ProfileEntity(
    @PrimaryKey val id: Long,
    val userId: Long,
    val bio: String,
)

data class UserWithProfile(
    @Embedded val user: UserEntity,
    @Relation(parentColumn = "id", entityColumn = "userId")
    val profile: ProfileEntity?,
)
```

### One-to-many

```kotlin
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

### Many-to-many with a junction table

```kotlin
@Entity(tableName = "playlist_song", primaryKeys = ["playlistId", "songId"],
    indices = [Index("songId")])
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

Here `parentColumn` is the primary key column in `PlaylistEntity`, and `entityColumn` is the primary key in `SongEntity`. Room uses the cross-ref table to connect them. For the reverse view (`SongWithPlaylists`) you write a second class with the roles swapped.

### Nested relations and projections

- A `@Relation` can point at another relation class, for example `UserWithPlaylistsAndSongs`.
- Use `entity = ...` plus `projection = [...]` on `@Relation` to load only some columns of the child.

```kotlin
@Relation(
    parentColumn = "id",
    entityColumn = "postId",
    entity = CommentEntity::class,
    projection = ["text"],
)
val commentTexts: List<String>
```

### Why @Transaction is needed for relations

A relation query is **not** one SQL statement. Room runs:

1. Your main query (`SELECT * FROM posts`).
2. One more query per relation, for example `SELECT * FROM comments WHERE postId IN (...)`.

Without a transaction, another write can happen between step 1 and step 2. You could get a post whose comments were deleted in between, or comments that do not match. `@Transaction` makes all queries see one consistent snapshot. It also helps when results are large and the cursor needs several windows.

> **Interview:** "Why does Room warn when you use @Relation without @Transaction?" Because it runs multiple queries to build the result, and without a transaction they can observe different states of the database.

### @Relation vs JOIN

| Approach | Pros | Cons |
|---|---|---|
| @Relation | Clean nested objects, no duplicate parents | Multiple queries, loads all children |
| JOIN into flat class | One query, filter on child columns | Duplicate parent data per row |
| JOIN into Map | One query, grouped result | Less control over ordering of children |

## Transactions and Threading

### Transactions

A transaction groups several operations so they all succeed or all fail. It also makes many writes much faster, because SQLite commits to disk once instead of once per statement.

```kotlin
// suspend version, from room-ktx (or room-runtime in newer versions)
suspend fun replaceAll(notes: List<NoteEntity>) {
    db.withTransaction {
        noteDao.deleteAll()
        noteDao.insertAll(notes)
    }
}
```

```kotlin
// Blocking version: call it off the main thread
db.runInTransaction {
    noteDao.deleteAllBlocking()
    noteDao.insertAllBlocking(notes)
}
```

You can also put the transaction in the DAO itself.

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
- `withTransaction` is coroutine-aware. DAO calls inside the block reuse the same transaction even though they suspend.
- Keep transactions short. A long transaction blocks other writers.
- Do not make network calls inside a transaction.

> **Pitfall:** Launching a new coroutine inside `withTransaction` (for example with `launch` on another scope) and doing DAO work there escapes the transaction. Keep all DAO calls in the transaction block's own coroutine.

> **Note:** Room 2.7 also added connection-level APIs (`useReaderConnection`, `useWriterConnection`) that work with the driver API and KMP. Most app code still uses DAOs plus `withTransaction`.

### The main-thread check

Room throws `IllegalStateException: Cannot access database on the main thread` if a blocking DAO call runs on the main thread. This protects you from jank and ANRs.

```kotlin
// Only for tests or tiny prototypes
Room.databaseBuilder(context, AppDatabase::class.java, "app.db")
    .allowMainThreadQueries()
    .build()
```

Never ship `allowMainThreadQueries()` in production code.

### How suspend and Flow DAOs dispatch

- A `suspend` DAO function is **main-safe**. You can call it from `viewModelScope` on `Dispatchers.Main`. Room moves the actual work to its own background executors and resumes you on the caller's context.
- You do not need `withContext(Dispatchers.IO)` around Room suspend calls. Adding it is harmless but redundant.
- A `Flow` DAO function also runs its query in the background. You collect on any dispatcher.
- Blocking (non-suspend, non-Flow) DAO functions run on the caller thread. That is why the main-thread check exists.

### Executors

On Android, Room has a **query executor** and a **transaction executor**. By default they use a shared background pool (Architecture Components IO executor). You can provide your own:

```kotlin
Room.databaseBuilder(context, AppDatabase::class.java, "app.db")
    .setQueryExecutor(myQueryExecutor)
    .setTransactionExecutor(myTransactionExecutor)
    .build()
```

With the coroutine-first APIs in Room 2.7 you can instead set a coroutine context, which is the usual choice in KMP code.

```kotlin
builder.setQueryCoroutineContext(Dispatchers.IO)
```

> **Under the hood:** SQLite allows only one writer at a time. Room serializes write transactions on a single writer connection. With WAL enabled, readers can use separate connections in parallel while a write is in progress.

## Migrations

When you change the schema (add a column, rename a table), you bump the database `version`. Room then needs to know how to move existing user data from the old version to the new one. If it cannot find a path, it throws at open time.

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

- Room chains migrations. A user on version 1 runs 1 to 2 then 2 to 3.
- You can also add a direct `Migration(1, 3)`; Room prefers the shortest path.
- After migrating, Room validates the resulting schema against what it expects. A mismatch throws `IllegalStateException` with "Migration didn't properly handle".

### Complex changes: the copy-table pattern

SQLite's `ALTER TABLE` is limited. To change a column type or drop a constraint, you recreate the table.

```sql
CREATE TABLE notes_new (
    id INTEGER PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    createdAt INTEGER NOT NULL
);
INSERT INTO notes_new (id, title, body, createdAt)
    SELECT id, title, IFNULL(body, ''), createdAt FROM notes;
DROP TABLE notes;
ALTER TABLE notes_new RENAME TO notes;
```

Copy the exact `CREATE TABLE` statement from the exported schema JSON of the new version. That guarantees it matches what Room expects.

### AutoMigration

For simple changes, Room can generate the migration by diffing two exported schema files. This needs `exportSchema = true` and the old schema JSON present.

```kotlin
@Database(
    entities = [NoteEntity::class],
    version = 3,
    autoMigrations = [
        AutoMigration(from = 1, to = 2),
        AutoMigration(from = 2, to = 3, spec = AppDatabase.Migration2To3::class),
    ]
)
abstract class AppDatabase : RoomDatabase() {
    @RenameColumn(tableName = "notes", fromColumnName = "text", toColumnName = "body")
    class Migration2To3 : AutoMigrationSpec
}
```

- Added columns and new tables are handled automatically. New non-null columns need a `defaultValue`.
- Renames and deletes are ambiguous (is it a rename or a drop plus add?), so you declare them in a spec with `@RenameColumn`, `@RenameTable`, `@DeleteColumn` or `@DeleteTable`.
- A spec can override `onPostMigrate` to run extra SQL, for example to backfill data.
- You can mix auto and manual migrations. A manual one for the same versions wins.

### Destructive fallback

```kotlin
Room.databaseBuilder(context, AppDatabase::class.java, "app.db")
    .fallbackToDestructiveMigration(dropAllTables = true)
    .build()
```

If no migration path exists, Room deletes all data and recreates the tables.

- Acceptable for a pure cache that can be refetched from the server.
- Unacceptable for user-created data such as drafts, notes, offline edits or unsynced changes.
- `fallbackToDestructiveMigrationFrom(...)` limits it to specific old versions.
- `fallbackToDestructiveMigrationOnDowngrade(...)` handles users who install an older build.

> **Pitfall:** Teams add destructive fallback "just for development" and ship it. The first time a migration is missing in production, users silently lose their data and nobody notices until reviews arrive.

### Testing migrations

`MigrationTestHelper` (from `room-testing`) creates a database at an old version from the exported schema, runs your migration, and validates the result.

```kotlin
@RunWith(AndroidJUnit4::class)
class MigrationTest {
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
}
```

The test needs the schema JSON files on the test classpath. A common setup adds them as assets for the androidTest source set.

```kotlin
android {
    sourceSets["androidTest"].assets.srcDir("$projectDir/schemas")
}
```

> **Tip:** Write one test that migrates from version 1 all the way to the latest, then opens the database with Room and runs a real query. That catches chain gaps and validation errors in one go.

### The exported schema JSON

Each version produces a file like `schemas/com.example.AppDatabase/3.json`. It contains every table's `CREATE` SQL, columns, indices, foreign keys and an identity hash. Room stores that hash in the `room_master_table` inside the user's database. On open, it compares the hash to decide whether the schema matches and whether a migration is needed.

## Beyond the Basics

### Pre-populating a database

Ship a ready-made database file in your APK and let Room copy it on first open.

```kotlin
Room.databaseBuilder(context, AppDatabase::class.java, "app.db")
    .createFromAsset("database/seed.db")
    .build()
```

- `createFromFile(file)` does the same from a file path.
- The asset's schema must match your entities exactly, or validation fails.
- The asset needs the right `user_version`. If it is older, Room runs migrations on the copied file.
- Copying only happens when the database does not exist yet.

An alternative is a `RoomDatabase.Callback` with `onCreate` that inserts seed rows with SQL. That is fine for small data.

### Database Inspector

Android Studio's **App Inspection** tool lets you browse tables, run SQL and see live updates in a running debuggable app (API 26+). You can even run DAO queries from the gutter icon next to a `@Query`. It is the fastest way to debug "why is my Flow empty".

### WAL mode basics

SQLite can use a rollback journal or **write-ahead logging (WAL)**. In WAL mode, writes go to a separate log file first.

- Readers do not block the writer, and the writer does not block readers.
- Writes are often faster because they are sequential appends.
- You will see `app.db-wal` and `app.db-shm` files next to `app.db`.

Room's default `JournalMode.AUTOMATIC` picks WAL on most devices (it avoids WAL on low-RAM devices). You can force a mode with `setJournalMode(...)`.

> **Pitfall:** When backing up or copying the database, copy all three files or checkpoint first. Copying only `app.db` can lose recent writes still in the WAL file.

Deep SQLite internals (pages, B-trees, checkpoints, query planner) are a Level 3 topic. For now, know that WAL exists, it is usually on, and it allows concurrent reads during writes.

### Full-text search with FTS4

For fast text search, Room supports SQLite's FTS virtual tables.

```kotlin
@Fts4(contentEntity = NoteEntity::class)
@Entity(tableName = "notes_fts")
data class NoteFts(
    val title: String,
    val body: String,
)

@Query("""
    SELECT notes.* FROM notes
    JOIN notes_fts ON notes.rowid = notes_fts.rowid
    WHERE notes_fts MATCH :query
""")
fun search(query: String): Flow<List<NoteEntity>>
```

- `MATCH` uses an inverted index, so it is far faster than `LIKE '%x%'` on big tables.
- `contentEntity` makes it an "external content" table that mirrors `notes` and avoids storing text twice. Room keeps it in sync with triggers.
- FTS tables use the implicit `rowid` as their key.
- The query syntax supports prefix search like `kot*`.

### Database views

`@DatabaseView` defines a saved SELECT that you can query like a table. It is handy for reusing a complex JOIN. List it under `views = [...]` in `@Database`.

### One instance, one process

Room must be a **singleton** per database file within a process.

- Each `RoomDatabase` instance has its own connections and its own `InvalidationTracker`.
- Two instances on the same file do not see each other's changes, so Flows from one never update after writes through the other.
- Two instances also waste memory and can cause lock contention.

If you truly use the database from multiple processes (for example a separate `:sync` process), call `enableMultiInstanceInvalidation()` on the builder in every process. Even then, keep one instance per process.

> **Interview:** "Why must the database be a singleton?" Because invalidation, connection pooling and write serialization are per instance. Two instances on one file break observation and risk "database is locked" errors.

## Room in the Architecture

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

    @Provides
    fun provideUserDao(db: AppDatabase): UserDao = db.userDao()
}
```

- The database is `@Singleton`. DAOs do not need the scope; `db.noteDao()` returns the same cached instance anyway.
- Inject DAOs into repositories, not into ViewModels. The ViewModel should not know Room exists.
- In tests, replace this module with one that builds an in-memory database.

### Room as the single source of truth

In an offline-first app, the UI **only** reads from the database. The network never pushes data straight to the UI. It writes into Room, and Room's Flow delivers the change.

```text
UI  <--  ViewModel (StateFlow)  <--  Repository.observe()  <--  Room Flow
                                          |
                                     refresh()
                                          |
                               Network  -->  Room (upsert in transaction)
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
        val remote = api.fetchNotes()
        db.withTransaction {
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
- Errors from the network do not wipe the screen. You show the cached data plus an error message.

### Writes in offline-first

For user edits, write locally first, then sync.

```kotlin
suspend fun editTitle(id: String, title: String) {
    dao.updateTitle(id, title, syncState = SyncState.PENDING)
    syncScheduler.enqueue() // e.g. WorkManager
}
```

- Keep a `syncState` or `isDirty` column so the sync worker knows what to push.
- When the server confirms, mark rows as synced.
- Be careful not to let a background `refresh()` overwrite pending local edits. Skip rows marked pending, or merge them.

### Keep layers separate

- Entities are a **storage model**. Do not use them directly as UI models or network DTOs.
- Map `Dto -> Entity` on the way in and `Entity -> Domain` on the way out.
- This lets you change the schema without touching the UI, and change the API without a migration.

## Testing

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

    @Test fun upsert_thenObserve_emitsNote() = runTest {
        dao.upsert(listOf(NoteEntity(id = 1, title = "a", body = "")))
        val notes = dao.observeAll().first()
        assertEquals(listOf(1L), notes.map { it.id })
    }
}
```

`allowMainThreadQueries()` is fine here because tests may call blocking helpers directly.

### Testing Flow emissions

Use Turbine (or collect into a list) to check that writes cause new emissions.

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

> **Note:** Room's invalidation runs on Room's own background executor, so these tests use real time for that part. If an emission seems to be missing, check that you are not swallowing it with `distinctUntilChanged` or that the write actually touched the observed table.

### Instrumented vs Robolectric

| Option | Where it runs | Pros | Cons |
|---|---|---|---|
| Instrumented (androidTest) | Device or emulator | Real Android SQLite, most accurate | Slow, needs a device |
| Robolectric (test) | JVM | Fast, runs in CI easily | SQLite version may differ from devices |
| Bundled driver on JVM | JVM | Same SQLite as production if you ship the bundled driver | Needs the driver API setup |

A common split: DAO tests on Robolectric for speed, migration tests instrumented for accuracy.

### What to test

- DAO queries with tricky SQL (filters, ordering, joins, relations).
- Conflict behavior (upsert, ignore).
- Every migration, with real data in the old version.
- Repository logic with a real in-memory database rather than a mocked DAO. Mocking a DAO tests your mock, not your SQL.

## Performance and Pitfalls

### Performance tips

- **Index** columns used in `WHERE`, `JOIN` and `ORDER BY`. Check with `EXPLAIN QUERY PLAN` in the Database Inspector.
- **Avoid `SELECT *`** for list screens. Project into a small data class.
- **Batch writes** in one transaction. Inserting 1,000 rows one by one outside a transaction is dramatically slower than one `insertAll` call.
- **Use `LIMIT`** and paging for long lists. Never load an unbounded table into memory.
- **Keep blobs out.** Store large files on disk and keep only a path in the table.
- **Narrow Flows.** Observe the smallest query that serves the screen, since any table change re-runs it.
- **`distinctUntilChanged()`** on Flows that feed expensive mapping or UI work.
- **Avoid N+1 queries.** Do not loop and call a DAO per item; use `IN (:ids)`, a JOIN, or `@Relation`.
- **Open the database early but lazily.** The first access creates or migrates the database, which can take time. Avoid doing it in `Application.onCreate` on the main thread.

```kotlin
// Slow: N transactions, N disk syncs
items.forEach { dao.insert(it) }

// Fast: one transaction
dao.insertAll(items)
```

### Common pitfalls

- Using `REPLACE` with cascading foreign keys, which deletes child rows.
- Forgetting `@Transaction` on queries that return `@Relation` classes.
- Creating more than one database instance, so Flows stop updating.
- Shipping `fallbackToDestructiveMigration` and losing user data.
- Changing an entity without bumping the version. Room throws "Room cannot verify the data integrity" on open.
- Bumping the version without a migration or exported schema, so auto-migration cannot be generated.
- Marking a `Flow` DAO function as `suspend`.
- Storing queryable lists as JSON strings.
- Using `Entity` classes as API DTOs, so a server rename forces a schema migration.
- Expecting a Flow to emit only when "my" row changes. Invalidation is per table.
- Long-running transactions or network calls inside `withTransaction`.
- Doing many small writes outside a transaction.
- Not committing the `schemas/` folder, which makes auto-migrations and migration tests impossible later.

## Interview Questions

### Q: Why use Room instead of SQLiteOpenHelper?

Room gives compile-time SQL verification, generated mapping code, observable queries through Flow, built-in coroutine support, a main-thread guard and migration tooling. It still uses SQLite underneath, so nothing is lost; it removes boilerplate and whole classes of runtime bugs.

### Q: What does Room generate at compile time?

An `_Impl` class for the database and for each DAO. The database impl creates tables and holds the InvalidationTracker. Each DAO impl prepares statements, binds parameters and maps rows to objects. With export on, it also writes a schema JSON file per version.

### Q: How does a Room Flow know when to re-emit?

Room's InvalidationTracker installs triggers on observed tables. After a write transaction, it checks which tables changed and notifies observers. The Flow then re-runs its query and emits. It works at the table level, so it can emit identical data; use `distinctUntilChanged()` if that matters.

### Q: Do I need withContext(Dispatchers.IO) around Room suspend functions?

No. Suspend DAO functions are main-safe. Room runs the query on its own background executor or coroutine context and resumes the caller. Blocking DAO functions are different: those run on the caller thread.

### Q: What is the difference between REPLACE and @Upsert?

`REPLACE` deletes the conflicting row and inserts a new one, which fires delete triggers and `ON DELETE CASCADE`. `@Upsert` tries an insert and on conflict performs an update of the existing row, so children and row identity stay intact.

### Q: Why is @Transaction needed with @Relation?

Room loads relations with several queries: the parent query and one query per relation. A transaction makes them all read one consistent snapshot. Without it, a concurrent write could leave parents and children out of sync.

### Q: How do you model a many-to-many relationship?

With a junction (cross-ref) entity that holds both foreign keys as a composite primary key. Then use `@Relation` with `associateBy = Junction(CrossRef::class)` in a result class like `PlaylistWithSongs`.

### Q: What happens if you change an entity but forget a migration?

On open, Room compares the identity hash of the expected schema with the one stored in the database. If the version is unchanged, it throws an integrity error. If the version is higher but no migration path exists, it throws a missing migration error, unless destructive fallback is enabled, in which case all data is wiped.

### Q: When would you use AutoMigration vs a manual Migration?

AutoMigration for simple, unambiguous changes like adding a table or a column with a default, plus renames or deletes declared in a spec. Manual migration for data transforms, type changes, splitting tables, or anything needing custom SQL.

### Q: How do you test migrations?

Use `MigrationTestHelper` with exported schemas. Create the database at the old version, insert realistic data, run `runMigrationsAndValidate` to the new version, then query to check the data survived. Also test the full chain from the oldest supported version.

### Q: Why must RoomDatabase be a singleton?

Invalidation tracking, connection pooling and write serialization are per instance. Two instances on one file do not see each other's writes, so Flows stop updating, and they can fight over locks.

### Q: Why is storing a list as JSON in a column considered a smell?

SQL cannot index or filter inside the blob, updates must rewrite the whole value, and format changes break at runtime. Anything you query belongs in its own table with a foreign key or junction.

### Q: Describe Room's role in an offline-first architecture.

Room is the single source of truth. The UI observes Room through the repository as a Flow. The network layer only writes into Room, inside a transaction. The Flow then pushes the new data to every observing screen. Local edits write to Room first with a pending flag and sync later.

### Q: What is WAL mode and why does it matter?

Write-ahead logging writes changes to a separate log file before merging them into the main file. Readers and the writer do not block each other, so reads stay fast during writes. Room enables it automatically on most devices.

### Q: How would you speed up a slow Room query on a big table?

Check the query plan, add an index on filtered or sorted columns, select only needed columns, add `LIMIT` or use paging, avoid N+1 patterns, and use FTS for text search instead of `LIKE '%x%'`.

### Q: What changed in Room 2.7 that a senior candidate should know?

Kotlin Multiplatform support, KSP-first with Kotlin code generation, and a new driver API (`SQLiteDriver`, with a bundled SQLite option) alongside coroutine-first connection APIs. Android-only apps keep working with the familiar builder and DAO APIs.

## Cheat Sheet and Practice

### Cheat sheet

| Need | Use |
|---|---|
| Table | @Entity with @PrimaryKey |
| Rename column | @ColumnInfo(name = ...) |
| Skip a field | @Ignore |
| Flatten object | @Embedded(prefix = ...) |
| Custom type | @TypeConverter + @TypeConverters |
| Insert or update | @Upsert |
| Insert if missing | @Insert(onConflict = IGNORE) |
| One-shot read | suspend fun with @Query |
| Observe | fun returning Flow (no suspend) |
| Paging | PagingSource from @Query + room-paging |
| Relations | @Embedded + @Relation + @Transaction |
| Many-to-many | Junction(CrossRef::class) |
| Atomic multi-step | db.withTransaction { } |
| Schema change | bump version + Migration or AutoMigration |
| Rename in auto-migration | AutoMigrationSpec + @RenameColumn |
| Ship seed data | createFromAsset |
| Text search | @Fts4 + MATCH |
| Tests | inMemoryDatabaseBuilder, MigrationTestHelper |
| Multi-process | enableMultiInstanceInvalidation |

Key rules to remember:

- One database instance per process. Provide it as a singleton.
- Room is the source of truth; network writes into Room.
- Invalidation is per table, after the transaction commits.
- Suspend DAOs are main-safe. Flow DAOs are not suspend.
- Batch writes in a transaction. Index what you filter and sort.
- Export schemas, commit them, test every migration.
- Never ship destructive fallback for user-created data.

### Practice exercises

1. Build a notes app database with `NoteEntity`, `TagEntity` and a `NoteTagCrossRef`. Write a DAO that returns `Flow<List<NoteWithTags>>` and a query that finds all notes with a given tag. Explain why you did not store tags as JSON.
2. Add a `pinned` column in version 2 using AutoMigration, then rename `body` to `content` in version 3 with an `AutoMigrationSpec`. Write a `MigrationTestHelper` test that migrates from 1 to 3 with real data.
3. Write an offline-first repository: `observeArticles()` returns a Room Flow, and `refresh()` fetches from a fake API and upserts in one transaction. Make sure a refresh does not overwrite articles with local pending edits.
4. Write a test that proves a Flow from `observeById(3)` re-emits when note 7 changes. Then add `distinctUntilChanged()` and show the duplicate emission is gone.
5. Insert 10,000 rows one at a time, then with `insertAll` inside a transaction, and measure both. Then add an FTS4 table for search and compare `MATCH` with `LIKE '%term%'` timings.

### References

- [Save data in a local database using Room](https://developer.android.com/training/data-storage/room)
- [Define data using Room entities](https://developer.android.com/training/data-storage/room/defining-data)
- [Access data using Room DAOs](https://developer.android.com/training/data-storage/room/accessing-data)
- [Define relationships between objects](https://developer.android.com/training/data-storage/room/relationships)
- [Write asynchronous DAO queries](https://developer.android.com/training/data-storage/room/async-queries)
- [Migrate your Room database](https://developer.android.com/training/data-storage/room/migrating-db-versions)
- [Test and debug your database](https://developer.android.com/training/data-storage/room/testing-db)
- [Prepopulate your Room database](https://developer.android.com/training/data-storage/room/prepopulate)
- [Referencing complex data using Room](https://developer.android.com/training/data-storage/room/referencing-data)
- [Room (Kotlin Multiplatform)](https://developer.android.com/kotlin/multiplatform/room)
- [Room release notes](https://developer.android.com/jetpack/androidx/releases/room)
- [Build an offline-first app](https://developer.android.com/topic/architecture/data-layer/offline-first)
- [Inspect databases with Database Inspector](https://developer.android.com/studio/inspect/database)
