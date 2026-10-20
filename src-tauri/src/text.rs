//! Text decoding/encoding that round-trips a file's encoding, BOM and line
//! endings, so saving never rewrites bytes the user did not touch.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TextEncoding {
    Utf8,
    Utf8Bom,
    Utf16le,
    Utf16be,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Decoded {
    Text {
        content: String,
        encoding: TextEncoding,
        eol: Eol,
    },
    Binary,
}

pub fn decode(bytes: &[u8]) -> Decoded {
    let (content, encoding) = if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        (
            String::from_utf8_lossy(rest).into_owned(),
            TextEncoding::Utf8Bom,
        )
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        let (s, _, _) = encoding_rs::UTF_16LE.decode(bytes);
        (s.into_owned(), TextEncoding::Utf16le)
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        let (s, _, _) = encoding_rs::UTF_16BE.decode(bytes);
        (s.into_owned(), TextEncoding::Utf16be)
    } else {
        if looks_binary(bytes) {
            return Decoded::Binary;
        }
        match std::str::from_utf8(bytes) {
            Ok(s) => (s.to_owned(), TextEncoding::Utf8),
            // Legacy single-byte files: show them, but most such files are UTF-8 with a stray byte.
            Err(_) => (
                String::from_utf8_lossy(bytes).into_owned(),
                TextEncoding::Utf8,
            ),
        }
    };
    let eol = detect_eol(&content);
    Decoded::Text {
        content,
        encoding,
        eol,
    }
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}

/// Majority line ending, LF when there are none.
pub fn detect_eol(s: &str) -> Eol {
    let crlf = s.matches("\r\n").count();
    let lf = s.matches('\n').count() - crlf;
    if crlf > lf {
        Eol::Crlf
    } else {
        Eol::Lf
    }
}

pub fn encode(content: &str, encoding: TextEncoding) -> Vec<u8> {
    match encoding {
        TextEncoding::Utf8 => content.as_bytes().to_vec(),
        TextEncoding::Utf8Bom => {
            let mut v = vec![0xEF, 0xBB, 0xBF];
            v.extend_from_slice(content.as_bytes());
            v
        }
        TextEncoding::Utf16le => {
            let mut v = vec![0xFF, 0xFE];
            v.extend(content.encode_utf16().flat_map(u16::to_le_bytes));
            v
        }
        TextEncoding::Utf16be => {
            let mut v = vec![0xFE, 0xFF];
            v.extend(content.encode_utf16().flat_map(u16::to_be_bytes));
            v
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(bytes: &[u8]) {
        match decode(bytes) {
            Decoded::Text {
                content, encoding, ..
            } => assert_eq!(encode(&content, encoding), bytes),
            Decoded::Binary => panic!("unexpected binary"),
        }
    }

    #[test]
    fn round_trips_encodings() {
        round_trip(b"namespace A;\nclass B {}\n");
        round_trip(b"\xEF\xBB\xBFnamespace A;\r\nclass B {}\r\n");
        round_trip(&encode("xin chào\r\n", TextEncoding::Utf16le));
        round_trip(&encode("xin chào\n", TextEncoding::Utf16be));
    }

    #[test]
    fn detects_eol_and_bom() {
        let Decoded::Text {
            encoding,
            eol,
            content,
        } = decode(b"\xEF\xBB\xBFa\r\nb\r\nc\n")
        else {
            panic!()
        };
        assert_eq!(encoding, TextEncoding::Utf8Bom);
        assert_eq!(eol, Eol::Crlf);
        assert_eq!(content, "a\r\nb\r\nc\n");
    }

    #[test]
    fn detects_binary() {
        assert_eq!(decode(b"MZ\x90\x00\x03"), Decoded::Binary);
    }
}
