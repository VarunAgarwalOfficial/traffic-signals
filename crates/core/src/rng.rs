//! Seeded random numbers and the two transcendental functions the model needs.
//!
//! `ln` and `exp` are written with plain arithmetic so that a run gives the same
//! bits on every target (the browser's WebAssembly build and the native command
//! line would otherwise use different maths libraries).

/// xoshiro256** seeded through SplitMix64.
#[derive(Clone, Debug)]
pub struct Rng {
    s: [u64; 4],
}

impl Rng {
    pub fn new(seed: u64) -> Self {
        let mut z = seed;
        let mut next = || {
            z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut x = z;
            x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            x ^ (x >> 31)
        };
        Self {
            s: [next(), next(), next(), next()],
        }
    }

    pub fn next_u64(&mut self) -> u64 {
        let result = self.s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.s[1] << 17;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(45);
        result
    }

    /// Uniform in [0, 1).
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Exponentially distributed with the given rate.
    pub fn exponential(&mut self, rate: f64) -> f64 {
        -ln(1.0 - self.unit()) / rate
    }
}

const LN2: f64 = core::f64::consts::LN_2;

/// Natural logarithm of a positive finite number.
pub fn ln(x: f64) -> f64 {
    if x <= 0.0 {
        return f64::NEG_INFINITY;
    }
    // x = m * 2^e with m in [1, 2), then fold m into [sqrt(1/2), sqrt(2)).
    let bits = x.to_bits();
    let mut e = ((bits >> 52) & 0x7ff) as i64 - 1023;
    let mut m = f64::from_bits((bits & 0x000f_ffff_ffff_ffff) | 0x3ff0_0000_0000_0000);
    if m > core::f64::consts::SQRT_2 {
        m *= 0.5;
        e += 1;
    }
    // ln m = 2 atanh(z), z = (m - 1) / (m + 1), |z| < 0.172.
    let z = (m - 1.0) / (m + 1.0);
    let z2 = z * z;
    let mut term = z;
    let mut sum = z;
    let mut k = 3.0;
    while k < 26.0 {
        term *= z2;
        sum += term / k;
        k += 2.0;
    }
    2.0 * sum + e as f64 * LN2
}

/// e to the power x.
pub fn exp(x: f64) -> f64 {
    if x > 700.0 {
        return f64::INFINITY;
    }
    if x < -700.0 {
        return 0.0;
    }
    let k = (x / LN2 + if x >= 0.0 { 0.5 } else { -0.5 }) as i64;
    let r = x - k as f64 * LN2;
    let mut term = 1.0;
    let mut sum = 1.0;
    let mut n = 1.0;
    while n < 18.0 {
        term *= r / n;
        sum += term;
        n += 1.0;
    }
    sum * f64::from_bits(((k + 1023) as u64) << 52)
}
