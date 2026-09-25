//! Frontend-safe normalized domain types.
//!
//! These types are the stable cross-layer contract shared by the Tauri commands,
//! application services, and database adapters. They deliberately contain no
//! driver-native connection/pool objects and no secret values, so they can be
//! serialized across the Tauri IPC boundary without leaking credentials.
//!
//! Secret material (passwords, tokens, TLS keys) is resolved by the application
//! from protected storage and handed to the adapter separately; it never appears
//! in these types or in their `Debug`/serialized output.

pub mod capabilities;
pub mod connection;
pub mod errors;
pub mod result;

pub use capabilities::{EngineCapabilities, EngineId};
pub use connection::{ConnectionDescriptor, ServerConnection, SqliteConnection, TlsMode};
pub use errors::{ErrorCategory, QueryError};
pub use result::{
    CellValue, ColumnInfo, OperationId, OperationState, QueryRequest, QueryResult, Row,
};
