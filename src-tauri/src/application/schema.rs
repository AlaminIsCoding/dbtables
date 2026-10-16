//! Schema (DDL) management use cases.
//!
//! These functions validate the structural shape of a schema request before it
//! reaches an adapter, then delegate to the shared [`DatabaseAdapter`] boundary.
//! The adapter remains responsible for engine-specific identifier validation
//! and quoting, so no caller-controlled text is ever placed in a statement.
//!
//! A request that an engine cannot honor (for example, adding or dropping a
//! foreign key on SQLite) surfaces as [`ErrorCategory::Unsupported`] rather
//! than a silent no-op.

use std::collections::HashSet;

use crate::database::{
    ColumnAlteration, ColumnDefinition, ConnectionId, DatabaseAdapter, ForeignKeyDefinition,
    ObjectKind, ObjectRef, TableDefinition, TableDescription, TableFilter,
};
use crate::domain::{ErrorCategory, QueryError};

/// Builds a normalized validation error.
fn validation(message: impl Into<String>) -> QueryError {
    QueryError::new(ErrorCategory::Validation, message)
}

/// Rejects a blank identifier with a validation error.
fn require_name(value: &str, what: &str) -> Result<(), QueryError> {
    if value.trim().is_empty() {
        return Err(validation(format!("a {what} name must not be empty")));
    }
    Ok(())
}

/// Validates a single column definition.
pub fn validate_column_definition(column: &ColumnDefinition) -> Result<(), QueryError> {
    require_name(&column.name, "column")?;
    if column.type_name.trim().is_empty() {
        return Err(validation(format!(
            "column `{}` requires a type name",
            column.name
        )));
    }
    Ok(())
}

/// Validates the structural shape of a foreign-key definition.
pub fn validate_foreign_key(foreign_key: &ForeignKeyDefinition) -> Result<(), QueryError> {
    if foreign_key.columns.is_empty()
        || foreign_key.columns.len() != foreign_key.referenced_columns.len()
    {
        return Err(validation(
            "a foreign key must pair one local column with one referenced column",
        ));
    }
    for column in foreign_key
        .columns
        .iter()
        .chain(foreign_key.referenced_columns.iter())
    {
        require_name(column, "foreign-key column")?;
    }
    require_name(&foreign_key.referenced_table, "referenced table")?;
    Ok(())
}

/// Validates a table definition before any engine call.
///
/// This checks only what is knowable without understanding an engine: a base
/// table name, at least one uniquely named column, at most one primary-key
/// column, and well-formed foreign keys. Whether referenced tables/columns
/// exist is the adapter's check against its own metadata.
pub fn validate_table_definition(definition: &TableDefinition) -> Result<(), QueryError> {
    if definition.object.kind != ObjectKind::Table {
        return Err(validation(format!(
            "`{}` is not a base table",
            definition.object.name
        )));
    }
    require_name(&definition.object.name, "table")?;
    if definition.columns.is_empty() {
        return Err(validation(
            "a table definition requires at least one column",
        ));
    }

    let mut seen = HashSet::new();
    let mut primary_key_columns = 0usize;
    for column in &definition.columns {
        validate_column_definition(column)?;
        if !seen.insert(column.name.trim().to_ascii_lowercase()) {
            return Err(validation(format!(
                "table `{}` defines column `{}` more than once",
                definition.object.name, column.name
            )));
        }
        if column.primary_key {
            primary_key_columns += 1;
        }
    }
    if primary_key_columns > 1 {
        return Err(validation(
            "a table may have at most one primary-key column in this slice",
        ));
    }

    for foreign_key in &definition.foreign_keys {
        validate_foreign_key(foreign_key)?;
    }
    Ok(())
}

/// Creates a table from a validated definition.
pub async fn create_table(
    adapter: &dyn DatabaseAdapter,
    connection: &ConnectionId,
    definition: &TableDefinition,
) -> Result<TableDescription, QueryError> {
    validate_table_definition(definition)?;
    adapter.create_table(connection, definition).await
}

/// Drops a table.
///
/// `cascade` is forwarded to the adapter; engines without `DROP ... CASCADE`
/// (such as SQLite) document that it is ignored.
pub async fn drop_table(
    adapter: &dyn DatabaseAdapter,
    connection: &ConnectionId,
    object: &ObjectRef,
    cascade: bool,
) -> Result<(), QueryError> {
    require_name(&object.name, "table")?;
    adapter.drop_table(connection, object, cascade).await
}

/// Adds a validated column to an existing table.
pub async fn add_column(
    adapter: &dyn DatabaseAdapter,
    connection: &ConnectionId,
    object: &ObjectRef,
    column: &ColumnDefinition,
) -> Result<(), QueryError> {
    validate_column_definition(column)?;
    adapter.add_column(connection, object, column).await
}

/// Renames a column on an existing table.
pub async fn rename_column(
    adapter: &dyn DatabaseAdapter,
    connection: &ConnectionId,
    object: &ObjectRef,
    from: &str,
    to: &str,
) -> Result<(), QueryError> {
    require_name(from, "column")?;
    require_name(to, "column")?;
    adapter.rename_column(connection, object, from, to).await
}

/// Drops a column from an existing table.
pub async fn drop_column(
    adapter: &dyn DatabaseAdapter,
    connection: &ConnectionId,
    object: &ObjectRef,
    column: &str,
) -> Result<(), QueryError> {
    require_name(column, "column")?;
    adapter.drop_column(connection, object, column).await
}

/// Alters a validated existing column's type, nullability, or default.
pub async fn alter_column(
    adapter: &dyn DatabaseAdapter,
    connection: &ConnectionId,
    object: &ObjectRef,
    alteration: &ColumnAlteration,
) -> Result<(), QueryError> {
    require_name(&alteration.name, "column")?;
    if alteration.type_name.is_none()
        && alteration.nullable.is_none()
        && alteration.set_default.is_none()
        && !alteration.drop_default
    {
        return Err(validation("no column change was requested"));
    }
    if alteration.set_default.is_some() && alteration.drop_default {
        return Err(validation(
            "a column default cannot be set and dropped at once",
        ));
    }
    adapter.alter_column(connection, object, alteration).await
}

/// Adds a validated foreign-key constraint to an existing table.
pub async fn add_foreign_key(
    adapter: &dyn DatabaseAdapter,
    connection: &ConnectionId,
    object: &ObjectRef,
    foreign_key: &ForeignKeyDefinition,
) -> Result<(), QueryError> {
    validate_foreign_key(foreign_key)?;
    adapter.add_foreign_key(connection, object, foreign_key).await
}

/// Drops a named foreign-key constraint from an existing table.
pub async fn drop_foreign_key(
    adapter: &dyn DatabaseAdapter,
    connection: &ConnectionId,
    object: &ObjectRef,
    name: &str,
) -> Result<(), QueryError> {
    require_name(name, "foreign-key constraint")?;
    adapter.drop_foreign_key(connection, object, name).await
}

/// Creates a validated index on a table's columns.
pub async fn create_index(
    adapter: &dyn DatabaseAdapter,
    connection: &ConnectionId,
    object: &ObjectRef,
    name: &str,
    columns: &[String],
    unique: bool,
) -> Result<(), QueryError> {
    require_name(name, "index")?;
    if columns.is_empty() {
        return Err(validation("an index requires at least one column"));
    }
    for column in columns {
        require_name(column, "index column")?;
    }
    adapter
        .create_index(connection, object, name, columns, unique)
        .await
}

/// Drops an index by name.
pub async fn drop_index(
    adapter: &dyn DatabaseAdapter,
    connection: &ConnectionId,
    object: &ObjectRef,
    name: &str,
) -> Result<(), QueryError> {
    require_name(name, "index")?;
    adapter.drop_index(connection, object, name).await
}

/// Counts a table's rows, applying validated filters.
pub async fn count_table_rows(
    adapter: &dyn DatabaseAdapter,
    connection: &ConnectionId,
    object: &ObjectRef,
    filters: &[TableFilter],
) -> Result<u64, QueryError> {
    adapter.count_table_rows(connection, object, filters).await
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};

    use super::{
        alter_column, count_table_rows, create_index, create_table, rename_column,
        validate_table_definition,
    };
    use crate::database::testing::FakeAdapter;
    use crate::database::{
        ColumnAlteration, ColumnDefinition, DatabaseAdapter, ObjectKind, ObjectRef, TableDefinition,
    };
    use crate::domain::connection::SqliteConnection;
    use crate::domain::{ConnectionDescriptor, EngineId, ErrorCategory};

    fn block_on<F: Future>(future: F) -> F::Output {
        let waker = Waker::noop();
        let mut context = Context::from_waker(waker);
        let mut future = Box::pin(future);
        loop {
            match future.as_mut().poll(&mut context) {
                Poll::Ready(value) => return value,
                Poll::Pending => std::thread::yield_now(),
            }
        }
    }

    fn sqlite_descriptor() -> ConnectionDescriptor {
        ConnectionDescriptor::Sqlite(SqliteConnection {
            file_path: "C:/data/app.sqlite".to_string(),
        })
    }

    fn table_object(name: &str) -> ObjectRef {
        ObjectRef {
            database: None,
            schema: None,
            name: name.to_string(),
            kind: ObjectKind::Table,
        }
    }

    #[test]
    fn validate_table_definition_rejects_malformed_shapes() {
        let empty = TableDefinition::new(table_object("widgets"), Vec::new());
        assert_eq!(
            validate_table_definition(&empty)
                .expect_err("an empty column list is invalid")
                .category,
            ErrorCategory::Validation
        );

        let duplicate = TableDefinition::new(
            table_object("widgets"),
            vec![
                ColumnDefinition::new("id", "INTEGER"),
                ColumnDefinition::new("ID", "TEXT"),
            ],
        );
        assert_eq!(
            validate_table_definition(&duplicate)
                .expect_err("duplicate columns are invalid")
                .category,
            ErrorCategory::Validation
        );

        let two_keys = TableDefinition::new(
            table_object("widgets"),
            vec![
                ColumnDefinition::new("id", "INTEGER").with_primary_key(),
                ColumnDefinition::new("tenant", "INTEGER").with_primary_key(),
            ],
        );
        assert_eq!(
            validate_table_definition(&two_keys)
                .expect_err("multiple primary keys are invalid")
                .category,
            ErrorCategory::Validation
        );

        let view = ObjectRef {
            database: None,
            schema: None,
            name: "active_users".to_string(),
            kind: ObjectKind::View,
        };
        let view_definition = TableDefinition::new(
            view,
            vec![ColumnDefinition::new("id", "INTEGER")],
        );
        assert_eq!(
            validate_table_definition(&view_definition)
                .expect_err("a view is not a base table")
                .category,
            ErrorCategory::Validation
        );
    }

    #[test]
    fn use_cases_validate_before_delegating() {
        let adapter = FakeAdapter::new(EngineId::Sqlite);
        let connection =
            block_on(adapter.connect(&sqlite_descriptor(), None)).expect("fake connect");

        // Validation runs first, so the fake's default Unsupported never shows.
        let empty = TableDefinition::new(table_object("widgets"), Vec::new());
        let error = block_on(create_table(&adapter, &connection, &empty))
            .expect_err("an empty definition is invalid");
        assert_eq!(error.category, ErrorCategory::Validation);

        let object = table_object("users");
        let rename = block_on(rename_column(&adapter, &connection, &object, "  ", "alias"))
            .expect_err("a blank source column is invalid");
        assert_eq!(rename.category, ErrorCategory::Validation);

        let index = block_on(create_index(&adapter, &connection, &object, "idx", &[], false))
            .expect_err("an index needs at least one column");
        assert_eq!(index.category, ErrorCategory::Validation);

        // A valid request falls through to the adapter, which is unsupported.
        let error = block_on(count_table_rows(&adapter, &connection, &object, &[]))
            .expect_err("the fake adapter does not count rows");
        assert_eq!(error.category, ErrorCategory::Unsupported);
    }

    #[test]
    fn alter_column_validates_before_delegating() {
        let adapter = FakeAdapter::new(EngineId::Sqlite);
        let connection =
            block_on(adapter.connect(&sqlite_descriptor(), None)).expect("fake connect");
        let object = table_object("users");

        let no_change = ColumnAlteration {
            name: "email".to_string(),
            type_name: None,
            nullable: None,
            set_default: None,
            drop_default: false,
        };
        assert_eq!(
            block_on(alter_column(&adapter, &connection, &object, &no_change))
                .expect_err("an empty alteration is invalid")
                .category,
            ErrorCategory::Validation
        );

        let conflicting_default = ColumnAlteration {
            name: "email".to_string(),
            type_name: None,
            nullable: None,
            set_default: Some("0".to_string()),
            drop_default: true,
        };
        assert_eq!(
            block_on(alter_column(
                &adapter,
                &connection,
                &object,
                &conflicting_default
            ))
            .expect_err("setting and dropping a default at once is invalid")
            .category,
            ErrorCategory::Validation
        );

        let valid = ColumnAlteration {
            name: "email".to_string(),
            type_name: Some("TEXT".to_string()),
            nullable: Some(false),
            set_default: None,
            drop_default: false,
        };
        // The fake adapter does not implement alter_column.
        assert_eq!(
            block_on(alter_column(&adapter, &connection, &object, &valid))
                .expect_err("the fake adapter cannot alter columns")
                .category,
            ErrorCategory::Unsupported
        );
    }
}
