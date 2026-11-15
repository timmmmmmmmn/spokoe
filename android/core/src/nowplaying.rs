//! Op Android regelt de app "Nu speelt" (MediaSession) zelf, met de gebeurtenissen uit de kern.

pub fn track(_title: &str, _artist: &str, _album: &str, _duration_ms: u32, _cover: &str) {}
pub fn state(_playing: bool, _position_ms: u32) {}
pub fn position(_position_ms: u32) {}
