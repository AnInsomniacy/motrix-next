use aes::cipher::block_padding::{Padding, Pkcs7};
use aes::cipher::generic_array::GenericArray;
use aes::cipher::typenum::U16;
use aes::cipher::{BlockDecrypt, BlockDecryptMut, KeyInit, KeyIvInit};
use aes::Aes128;
use cbc::Decryptor;

use crate::error::AppError;

const INVALID_KEY: &str = "invalid-key";
const INVALID_CIPHERTEXT: &str = "invalid-ciphertext";

/// AES-128 decrypt with PKCS7. `ecb == false` uses CBC; `ecb == true` uses ECB.
pub fn decrypt_aes128(
    data: &[u8],
    key: &[u8],
    iv: &[u8; 16],
    ecb: bool,
) -> Result<Vec<u8>, AppError> {
    if key.len() != 16 {
        return Err(hls_err(INVALID_KEY));
    }
    if !data.len().is_multiple_of(16) {
        return Err(hls_err(INVALID_CIPHERTEXT));
    }
    if ecb {
        decrypt_ecb(data, key)
    } else {
        decrypt_cbc(data, key, iv)
    }
}

fn hls_err(code: &str) -> AppError {
    AppError::Hls(code.into())
}

fn decrypt_cbc(data: &[u8], key: &[u8], iv: &[u8; 16]) -> Result<Vec<u8>, AppError> {
    let key: [u8; 16] = key.try_into().map_err(|_| hls_err(INVALID_KEY))?;
    Decryptor::<Aes128>::new((&key).into(), iv.into())
        .decrypt_padded_vec_mut::<Pkcs7>(data)
        .map_err(|_| hls_err(INVALID_CIPHERTEXT))
}

fn decrypt_ecb(data: &[u8], key: &[u8]) -> Result<Vec<u8>, AppError> {
    let key: [u8; 16] = key.try_into().map_err(|_| hls_err(INVALID_KEY))?;
    let cipher = Aes128::new((&key).into());
    let mut buf = data.to_vec();
    for chunk in buf.chunks_exact_mut(16) {
        let mut block = GenericArray::clone_from_slice(chunk);
        cipher.decrypt_block(&mut block);
        chunk.copy_from_slice(&block);
    }
    let last_offset = buf
        .len()
        .checked_sub(16)
        .ok_or_else(|| hls_err(INVALID_CIPHERTEXT))?;
    let last_block = GenericArray::<u8, U16>::clone_from_slice(&buf[last_offset..]);
    let unpadded_last = Pkcs7::unpad(&last_block).map_err(|_| hls_err(INVALID_CIPHERTEXT))?;
    buf.truncate(last_offset + unpadded_last.len());
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::decrypt_aes128;
    use aes::cipher::{generic_array::GenericArray, BlockEncrypt, KeyInit, KeyIvInit};
    use aes::Aes128;
    use cbc::cipher::block_padding::Pkcs7;
    use cbc::cipher::BlockEncryptMut;
    use cbc::Encryptor;

    const PLAINTEXT: &[u8] = b"0123456789abcdef!";
    const KEY: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    const IV: [u8; 16] = [
        16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
    ];

    fn encrypt_for_test(data: &[u8], key: &[u8], iv: &[u8; 16]) -> Vec<u8> {
        let key: [u8; 16] = key.try_into().expect("16-byte key");
        Encryptor::<Aes128>::new((&key).into(), iv.into()).encrypt_padded_vec_mut::<Pkcs7>(data)
    }

    fn encrypt_ecb_for_test(data: &[u8], key: &[u8]) -> Vec<u8> {
        let key: [u8; 16] = key.try_into().expect("16-byte key");
        let cipher = Aes128::new((&key).into());
        let pad = 16 - (data.len() % 16);
        let mut buf = data.to_vec();
        buf.extend(std::iter::repeat_n(pad as u8, pad));
        for chunk in buf.chunks_exact_mut(16) {
            let mut block = GenericArray::clone_from_slice(chunk);
            cipher.encrypt_block(&mut block);
            chunk.copy_from_slice(&block);
        }
        buf
    }

    #[test]
    fn decrypt_aes128_roundtrip_cbc_pkcs7() {
        let ciphertext = encrypt_for_test(PLAINTEXT, &KEY, &IV);
        let plain = decrypt_aes128(&ciphertext, &KEY, &IV, false).expect("decrypt");
        assert_eq!(plain, PLAINTEXT);
    }

    #[test]
    fn decrypt_aes128_rejects_non_block_aligned_ciphertext() {
        let err = decrypt_aes128(b"short", &KEY, &IV, false).expect_err("len");
        assert!(
            matches!(err, crate::error::AppError::Hls(_)),
            "expected AppError::Hls, got {err}"
        );
    }

    #[test]
    fn decrypt_aes128_roundtrip_ecb_pkcs7() {
        let ciphertext = encrypt_ecb_for_test(PLAINTEXT, &KEY);
        let plain = decrypt_aes128(&ciphertext, &KEY, &IV, true).expect("ecb decrypt");
        assert_eq!(plain, PLAINTEXT);
    }

    #[test]
    fn decrypt_aes128_rejects_non_16_byte_key() {
        let ciphertext = encrypt_for_test(PLAINTEXT, &KEY, &IV);
        let err = decrypt_aes128(&ciphertext, &KEY[..15], &IV, false).expect_err("key");
        assert!(
            matches!(err, crate::error::AppError::Hls(_)),
            "expected AppError::Hls, got {err}"
        );
    }
}
