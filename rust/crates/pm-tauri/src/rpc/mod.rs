//! RPC 方法实现，按业务域拆分。每个模块的 `dispatch` 返回 `Option<Value>`：
//! 命中就给出结果，未命中返回 `None` 交给下一个模块。

pub mod cluster;
pub mod inspect;
pub mod message;
pub mod observe;
pub mod policy;
pub mod resource;
pub mod system;
pub mod workbench;
