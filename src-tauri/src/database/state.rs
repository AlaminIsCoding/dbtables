//! Multi-engine adapter registry.
//!
//! The application is engine-agnostic: every service takes a `&dyn
//! DatabaseAdapter`. This registry owns one adapter per supported engine and
//! remembers which engine owns each open connection, so a connection-scoped
//! command can resolve the right adapter from the opaque [`ConnectionId`] alone
//! without widening every command signature.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use crate::domain::{EngineId, ErrorCategory, QueryError};

use super::{ConnectionId, DatabaseAdapter, MySqlAdapter, PostgresAdapter, SqliteAdapter};

/// Owns the per-engine adapters and the connection-to-engine map.
pub struct DatabaseState {
    sqlite: SqliteAdapter,
    mysql: MySqlAdapter,
    postgres: PostgresAdapter,
    connections: Mutex<HashMap<String, EngineId>>,
}

impl DatabaseState {
    /// Builds a registry with a fresh adapter for every engine.
    ///
    /// Each adapter owns its own connection pool/handle map, so the state is a
    /// thin router rather than a place that holds driver objects itself.
    pub fn new() -> Self {
        Self {
            sqlite: SqliteAdapter::new(),
            mysql: MySqlAdapter::new(),
            postgres: PostgresAdapter::new(),
            connections: Mutex::new(HashMap::new()),
        }
    }

    /// Adapter serving `engine`.
    pub fn adapter(&self, engine: EngineId) -> &dyn DatabaseAdapter {
        match engine {
            EngineId::Sqlite => &self.sqlite,
            EngineId::MySql => &self.mysql,
            EngineId::Postgres => &self.postgres,
        }
    }

    /// Adapter serving the engine that owns `connection`.
    ///
    /// Returns a `validation` error for an unknown token, matching the
    /// precondition-failure contract every adapter uses for a missing
    /// connection.
    pub fn adapter_for(
        &self,
        connection: &ConnectionId,
    ) -> Result<&dyn DatabaseAdapter, QueryError> {
        let engine = self.engine_of(connection)?;
        Ok(self.adapter(engine))
    }

    /// Engine that owns `connection`.
    pub fn engine_of(&self, connection: &ConnectionId) -> Result<EngineId, QueryError> {
        self.lock()
            .get(connection.as_str())
            .copied()
            .ok_or_else(|| {
                QueryError::new(
                    ErrorCategory::Validation,
                    format!("unknown connection `{connection}`"),
                )
            })
    }

    /// Remembers the engine that owns a newly opened connection.
    pub fn record(&self, connection: &ConnectionId, engine: EngineId) {
        self.lock().insert(connection.as_str().to_string(), engine);
    }

    /// Forgets a connection after it is closed.
    ///
    /// Safe to call for an unknown token so teardown never panics.
    pub fn forget(&self, connection: &ConnectionId) {
        self.lock().remove(connection.as_str());
    }

    /// Whether `connection` is currently tracked.
    pub fn contains(&self, connection: &ConnectionId) -> bool {
        self.lock().contains_key(connection.as_str())
    }

    /// Number of currently tracked connections, for diagnostics and tests.
    pub fn tracked_connection_count(&self) -> usize {
        self.lock().len()
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, EngineId>> {
        // A panic while holding the lock cannot corrupt a routing map, so the
        // inner value is recovered instead of propagating the poison.
        self.connections
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Default for DatabaseState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::DatabaseState;
    use crate::database::ConnectionId;
    use crate::domain::{EngineId, ErrorCategory};

    #[test]
    fn resolves_the_adapter_for_each_engine() {
        let state = DatabaseState::new();

        assert_eq!(state.adapter(EngineId::Sqlite).engine(), EngineId::Sqlite);
        assert_eq!(state.adapter(EngineId::MySql).engine(), EngineId::MySql);
        assert_eq!(
            state.adapter(EngineId::Postgres).engine(),
            EngineId::Postgres
        );
    }

    #[test]
    fn records_and_forgets_connection_engines() {
        let state = DatabaseState::new();
        let connection = ConnectionId::new("c1");

        state.record(&connection, EngineId::Postgres);
        assert!(state.contains(&connection));
        assert_eq!(state.tracked_connection_count(), 1);
        assert_eq!(
            state.adapter_for(&connection).expect("adapter").engine(),
            EngineId::Postgres
        );

        // Recording again replaces the mapping rather than duplicating it.
        state.record(&connection, EngineId::MySql);
        assert_eq!(state.tracked_connection_count(), 1);
        assert_eq!(
            state.engine_of(&connection).expect("engine"),
            EngineId::MySql
        );

        state.forget(&connection);
        assert!(!state.contains(&connection));
        assert_eq!(state.tracked_connection_count(), 0);
    }

    #[test]
    fn unknown_connection_is_a_validation_error() {
        let state = DatabaseState::new();
        let error = state
            .adapter_for(&ConnectionId::new("missing"))
            .err()
            .expect("unknown connection must fail");

        assert_eq!(error.category, ErrorCategory::Validation);
    }

    #[test]
    fn forgetting_an_unknown_connection_is_a_no_op() {
        let state = DatabaseState::new();
        state.forget(&ConnectionId::new("never-recorded"));
        assert_eq!(state.tracked_connection_count(), 0);
    }
}
