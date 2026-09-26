//! Connection lifecycle use cases.
//!
//! Tauri command handlers stay thin by calling these functions instead of an
//! adapter directly. Each function validates that a descriptor matches the
//! adapter being addressed and then delegates the driver work. Driver-native
//! connection objects never cross this boundary: callers receive opaque,
//! serializable [`ConnectionId`] tokens only.

use crate::database::{
    ConnectionId, ConnectionSecret, ConnectionState, ConnectionTest, DatabaseAdapter,
};
use crate::domain::{ConnectionDescriptor, ErrorCategory, QueryError, ServerConnection, SqliteConnection};

/// Builds a SQLite connection descriptor for a local database file path.
pub fn sqlite_descriptor(file_path: impl Into<String>) -> ConnectionDescriptor {
    ConnectionDescriptor::Sqlite(SqliteConnection {
        file_path: file_path.into(),
    })
}

/// Builds a MySQL connection descriptor from secret-free server settings.
///
/// The password is not part of the descriptor; it is resolved from protected
/// storage and supplied to [`connect`]/[`test_connection`] separately.
pub fn mysql_descriptor(connection: ServerConnection) -> ConnectionDescriptor {
    ConnectionDescriptor::MySql(connection)
}

/// Confirms a descriptor targets the engine served by `adapter`.
fn ensure_engine(
    adapter: &dyn DatabaseAdapter,
    descriptor: &ConnectionDescriptor,
) -> Result<(), QueryError> {
    if descriptor.engine() == adapter.engine() {
        Ok(())
    } else {
        Err(QueryError::new(
            ErrorCategory::Configuration,
            format!(
                "the {} adapter cannot serve a {} connection",
                adapter.engine(),
                descriptor.engine()
            ),
        ))
    }
}

/// Verifies a descriptor and credential without retaining a connection.
pub async fn test_connection(
    adapter: &dyn DatabaseAdapter,
    descriptor: &ConnectionDescriptor,
    secret: Option<&ConnectionSecret>,
) -> Result<ConnectionTest, QueryError> {
    ensure_engine(adapter, descriptor)?;
    adapter.test_connection(descriptor, secret).await
}

/// Opens a connection and returns its opaque handle.
pub async fn connect(
    adapter: &dyn DatabaseAdapter,
    descriptor: &ConnectionDescriptor,
    secret: Option<&ConnectionSecret>,
) -> Result<ConnectionId, QueryError> {
    ensure_engine(adapter, descriptor)?;
    adapter.connect(descriptor, secret).await
}

/// Closes a connection previously returned by [`connect`].
pub async fn disconnect(
    adapter: &dyn DatabaseAdapter,
    connection: &ConnectionId,
) -> Result<(), QueryError> {
    adapter.disconnect(connection).await
}

/// Reports the current state of a known connection.
pub async fn connection_state(
    adapter: &dyn DatabaseAdapter,
    connection: &ConnectionId,
) -> Result<ConnectionState, QueryError> {
    adapter.connection_state(connection).await
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};

    use super::{connect, ensure_engine, mysql_descriptor, sqlite_descriptor};
    use crate::application::queries::execute_query;
    use crate::database::testing::FakeAdapter;
    use crate::database::{ConnectionSecret, SqliteAdapter};
    use crate::domain::connection::{ServerConnection, TlsMode};
    use crate::domain::{
        ConnectionDescriptor, EngineId, ErrorCategory, OperationState, QueryRequest,
    };

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

    fn mysql_server() -> ServerConnection {
        ServerConnection {
            host: "db.example.com".to_string(),
            port: 3306,
            database: Some("app".to_string()),
            username: "app_user".to_string(),
            tls: TlsMode::Disabled,
        }
    }

    #[test]
    fn sqlite_descriptor_carries_the_file_path() {
        let descriptor = sqlite_descriptor("C:/data/app.sqlite");

        assert_eq!(descriptor.engine(), EngineId::Sqlite);
        assert_eq!(descriptor.sqlite_file_path(), Some("C:/data/app.sqlite"));
    }

    #[test]
    fn mysql_descriptor_carries_server_settings_without_secrets() {
        let descriptor = mysql_descriptor(mysql_server());

        assert_eq!(descriptor.engine(), EngineId::MySql);
        let server = descriptor.server().expect("MySQL descriptor hold server settings");
        assert_eq!(server.host, "db.example.com");
        assert_eq!(server.port, 3306);
        assert_eq!(server.database.as_deref(), Some("app"));
        assert_eq!(server.username, "app_user");

        let serialized = serde_json::to_string(&descriptor).expect("descriptor should serialize");
        assert!(!serialized.to_lowercase().contains("password"));
        assert!(!serialized.to_lowercase().contains("secret"));
    }

    #[test]
    fn ensure_engine_rejects_a_mismatched_descriptor() {
        let adapter = SqliteAdapter::new();
        let descriptor = ConnectionDescriptor::Postgres(ServerConnection {
            host: "localhost".to_string(),
            port: 5432,
            database: Some("app".to_string()),
            username: "app_user".to_string(),
            tls: TlsMode::Preferred,
        });

        let error = ensure_engine(&adapter, &descriptor).expect_err("mismatch must fail");
        assert_eq!(error.category, ErrorCategory::Configuration);
    }

    #[test]
    fn mysql_connect_and_query_flow_works_through_the_services() {
        let adapter = FakeAdapter::new(EngineId::MySql);
        let descriptor = mysql_descriptor(mysql_server());
        let secret = ConnectionSecret::new("test-only-value");

        let connection = block_on(connect(&adapter, &descriptor, Some(&secret)))
            .expect("MySQL connect should succeed through the application service");

        let result = block_on(execute_query(
            &adapter,
            &connection,
            QueryRequest::new("op", "SELECT id, name FROM users"),
        ))
        .expect("MySQL query should run through the application service");
        assert_eq!(result.state, OperationState::Succeeded);
        assert!(!result.rows.is_empty());
    }
}
