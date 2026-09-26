//! Metadata inspection use cases.
//!
//! These functions expose object listing and table/view description to the
//! command layer while keeping the adapter boundary in one place. They do not
//! cache metadata; callers re-read it through the active connection so a
//! refreshed view always reflects the database.

use crate::database::{
    ConnectionId, DatabaseAdapter, ObjectRef, ObjectScope, ScopeListing, TableDescription,
};
use crate::domain::QueryError;

/// Lists tables and views in the requested scope.
pub async fn list_objects(
    adapter: &dyn DatabaseAdapter,
    connection: &ConnectionId,
    scope: &ObjectScope,
) -> Result<Vec<ObjectRef>, QueryError> {
    adapter.list_objects(connection, scope).await
}

/// Lists database/catalog and schema scopes, when the engine exposes them.
pub async fn list_scopes(
    adapter: &dyn DatabaseAdapter,
    connection: &ConnectionId,
) -> Result<ScopeListing, QueryError> {
    adapter.list_scopes(connection).await
}

/// Describes the columns, primary key, indexes, and constraints of a table or
/// view.
///
/// The optional index/constraint lists in the returned [`TableDescription`]
/// distinguish "not supported" (`None`) from "none exist" (`Some(empty)`), so
/// callers can render unsupported metadata honestly instead of as empty.
pub async fn describe_table(
    adapter: &dyn DatabaseAdapter,
    connection: &ConnectionId,
    object: &ObjectRef,
) -> Result<TableDescription, QueryError> {
    adapter.describe_table(connection, object).await
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};

    use super::{describe_table, list_objects, list_scopes};
    use crate::database::testing::FakeAdapter;
    use crate::database::{ConnectionSecret, ConstraintKind, DatabaseAdapter, ObjectScope};
    use crate::domain::connection::{ServerConnection, SqliteConnection, TlsMode};
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

    #[test]
    fn metadata_use_cases_delegate_to_the_adapter() {
        let adapter = FakeAdapter::new(EngineId::Sqlite);
        let descriptor = ConnectionDescriptor::Sqlite(SqliteConnection {
            file_path: "C:/data/app.sqlite".to_string(),
        });
        let connection =
            block_on(adapter.connect(&descriptor, None)).expect("fake connect should succeed");

        let scopes_error = block_on(list_scopes(&adapter, &connection))
            .expect_err("SQLite exposes no database/schema scopes");
        assert_eq!(scopes_error.category, ErrorCategory::Unsupported);

        let objects = block_on(list_objects(&adapter, &connection, &ObjectScope::default()))
            .expect("listing should succeed");
        assert_eq!(objects.len(), 2);

        let description = block_on(describe_table(&adapter, &connection, &objects[0]))
            .expect("description should succeed");
        assert_eq!(description.columns[0].name, "id");
        assert_eq!(description.primary_key_columns, ["id"]);

        // The detail call carries the full inspected metadata, not just columns.
        let indexes = description
            .indexes
            .expect("index metadata should flow through the service");
        assert!(indexes.iter().any(|index| index.primary));
        let constraints = description
            .constraints
            .expect("constraint metadata should flow through the service");
        assert!(constraints
            .iter()
            .any(|constraint| constraint.kind == ConstraintKind::PrimaryKey));
    }

    #[test]
    fn scope_listing_delegates_for_an_engine_that_exposes_scopes() {
        let adapter = FakeAdapter::new(EngineId::Postgres);
        let descriptor = ConnectionDescriptor::Postgres(ServerConnection {
            host: "localhost".to_string(),
            port: 5432,
            database: Some("app".to_string()),
            username: "app_user".to_string(),
            tls: TlsMode::Preferred,
        });
        let secret = ConnectionSecret::new("correct-horse");
        let connection = block_on(adapter.connect(&descriptor, Some(&secret)))
            .expect("fake connect should succeed");

        let listing = block_on(list_scopes(&adapter, &connection))
            .expect("PostgreSQL exposes schemas through the service");
        assert_eq!(listing.schemas, ["public"]);
    }
}
