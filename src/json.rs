//! A JSON value, for the parts of a document that forge keeps without
//! reading them, such as the extensions of a [`Method`](crate::Method).

use std::fmt;

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};

/// A JSON value, read the way JavaScript's `JSON.parse` reads one.
///
/// It can be read from any format serde can read, such as YAML, as long as
/// the value is one JSON could write.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    /// A number, as a 64-bit float, as in JavaScript: an integer beyond
    /// 2^53 in magnitude loses precision.
    Number(f64),
    String(String),
    Array(Vec<Json>),
    /// An object's members, in the order they are written. A key written
    /// more than once has the last value written, in the place of the
    /// first, as with `JSON.parse`, so each key is there once.
    ///
    /// Two objects are equal only when their members are in the same
    /// order.
    Object(Vec<(String, Json)>),
}

impl Json {
    /// Reports whether the value is `null`.
    pub fn is_null(&self) -> bool {
        matches!(self, Json::Null)
    }

    /// Returns the value if it is a boolean, or else `None`.
    pub fn as_bool(&self) -> Option<bool> {
        match *self {
            Json::Bool(b) => Some(b),
            _ => None,
        }
    }

    /// Returns the value if it is a number, or else `None`.
    pub fn as_f64(&self) -> Option<f64> {
        match *self {
            Json::Number(n) => Some(n),
            _ => None,
        }
    }

    /// Returns the value if it is a string, or else `None`.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::String(s) => Some(s),
            _ => None,
        }
    }

    /// Returns the elements if the value is an array, or else `None`.
    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Array(elements) => Some(elements),
            _ => None,
        }
    }

    /// Returns the members if the value is an object, in the order they
    /// are written, or else `None`.
    pub fn as_object(&self) -> Option<&[(String, Json)]> {
        match self {
            Json::Object(members) => Some(members),
            _ => None,
        }
    }

    /// Returns the value of the member `key` if the value is an object
    /// that has one, or else `None`. A key written more than once has the
    /// last value written.
    pub fn get(&self, key: &str) -> Option<&Json> {
        let members = self.as_object()?;
        members.iter().find(|(k, _)| k == key).map(|(_, value)| value)
    }
}

/// Sets the member `key` of `members` to `value`, in the place of the
/// member already there if there is one.
pub(crate) fn insert(members: &mut Vec<(String, Json)>, key: String, value: Json) {
    match members.iter_mut().find(|(k, _)| *k == key) {
        Some((_, old)) => *old = value,
        None => members.push((key, value)),
    }
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Json, D::Error> {
        deserializer.deserialize_any(JsonVisitor)
    }
}

struct JsonVisitor;

impl<'de> Visitor<'de> for JsonVisitor {
    type Value = Json;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("any JSON value")
    }

    fn visit_unit<E: de::Error>(self) -> Result<Json, E> {
        Ok(Json::Null)
    }

    fn visit_none<E: de::Error>(self) -> Result<Json, E> {
        Ok(Json::Null)
    }

    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Json, D::Error> {
        Json::deserialize(deserializer)
    }

    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Json, E> {
        Ok(Json::Bool(v))
    }

    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Json, E> {
        Ok(Json::Number(v as f64))
    }

    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Json, E> {
        Ok(Json::Number(v as f64))
    }

    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Json, E> {
        Ok(Json::Number(v))
    }

    fn visit_str<E: de::Error>(self, v: &str) -> Result<Json, E> {
        Ok(Json::String(v.to_owned()))
    }

    fn visit_string<E: de::Error>(self, v: String) -> Result<Json, E> {
        Ok(Json::String(v))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
        let mut elements = Vec::with_capacity(seq.size_hint().unwrap_or(0));
        while let Some(element) = seq.next_element()? {
            elements.push(element);
        }
        Ok(Json::Array(elements))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
        let mut members = Vec::with_capacity(map.size_hint().unwrap_or(0));
        while let Some((key, value)) = map.next_entry()? {
            insert(&mut members, key, value);
        }
        Ok(Json::Object(members))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads `json`, which must succeed.
    #[track_caller]
    fn read(json: &str) -> Json {
        match serde_json::from_str(json) {
            Ok(value) => value,
            Err(err) => panic!("read {json}: {err}"),
        }
    }

    /// Returns the keys of the object `value` is, in order.
    fn keys(value: &Json) -> Vec<&str> {
        value.as_object().unwrap().iter().map(|(k, _)| k.as_str()).collect()
    }

    #[test]
    fn scalars_are_their_variants() {
        assert_eq!(read("null"), Json::Null);
        assert_eq!(read("true"), Json::Bool(true));
        assert_eq!(read(r#""a""#), Json::String("a".into()));
    }

    #[test]
    fn every_number_is_a_float() {
        assert_eq!(read("-3"), Json::Number(-3.0));
        assert_eq!(read("3"), Json::Number(3.0));
        assert_eq!(read("1.5e2"), Json::Number(150.0));
    }

    #[test]
    fn integers_beyond_2_to_the_53_lose_precision() {
        assert_eq!(read("9007199254740993"), Json::Number(9_007_199_254_740_992.0));
    }

    #[test]
    fn object_keeps_its_keys_in_the_order_they_are_written() {
        assert_eq!(keys(&read(r#"{"b": 1, "a": 2, "c": 3}"#)), ["b", "a", "c"]);
    }

    #[test]
    fn repeated_key_has_the_last_value_in_the_place_of_the_first() {
        let value = read(r#"{"a": 1, "b": 2, "a": 3}"#);

        assert_eq!(keys(&value), ["a", "b"]);
        assert_eq!(value.get("a"), Some(&Json::Number(3.0)));
    }

    #[test]
    fn values_nest() {
        let value = read(r#"{"a": [1, {"b": null}], "c": {}}"#);

        let a = value.get("a").and_then(Json::as_array).unwrap();
        assert_eq!(a[0], Json::Number(1.0));
        assert!(a[1].get("b").unwrap().is_null());
        assert_eq!(value.get("c"), Some(&Json::Object(Vec::new())));
    }

    #[test]
    fn accessors_return_the_value_of_their_variant() {
        assert_eq!(read("true").as_bool(), Some(true));
        assert_eq!(read("2").as_f64(), Some(2.0));
        assert_eq!(read(r#""s""#).as_str(), Some("s"));
        assert_eq!(read("[null]").as_array(), Some(&[Json::Null][..]));
        let members = [("k".to_string(), Json::String("v".into()))];
        assert_eq!(read(r#"{"k": "v"}"#).as_object(), Some(&members[..]));
        assert!(read("null").is_null());
    }

    #[test]
    fn accessors_of_another_variant_are_none() {
        let value = read(r#""true""#);

        assert_eq!(value.as_bool(), None);
        assert_eq!(value.as_f64(), None);
        assert_eq!(value.as_array(), None);
        assert_eq!(value.as_object(), None);
        assert!(!value.is_null());
        assert_eq!(read("1").as_str(), None);
    }

    #[test]
    fn get_is_none_for_a_missing_key_or_a_value_that_is_not_an_object() {
        assert_eq!(read(r#"{"a": 1}"#).get("b"), None);
        assert_eq!(read(r#"[{"a": 1}]"#).get("a"), None);
    }
}
