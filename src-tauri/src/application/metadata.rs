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

/// Describes the columns and primary key of a table or view.
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

    use super::{describe_table, list_objects};
    use crate::database::testing::FakeAdapter;
    use crate::database::{DatabaseAdapter, ObjectScope};
    use crate::domain::connection::SqliteConnection;
    use crate::domain::{ConnectionDescriptor, EngineId};

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

        let objects = block_on(list_objects(&adapter, &connection, &ObjectScope::default()))
            .expect("listing should succeed");
        assert_eq!(objects.len(), 2);

        let description = block_on(describe_table(&adapter, &connection, &objects[0]))
            .expect("description should succeed");
        assert_eq!(description.columns[0].name, "id");
        assert_eq!(description.primary_key_columns, ["id"]);
    }
}
