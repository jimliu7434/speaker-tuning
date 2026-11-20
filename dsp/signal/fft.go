package signal

import (
	"math"
	"math/cmplx"
)

// NextPow2 returns the smallest power of 2 >= n.
func NextPow2(n int) int {
	p := 1
	for p < n {
		p <<= 1
	}
	return p
}

// FFT performs an in-place Cooley-Tukey radix-2 FFT (or IFFT if inverse is true).
// len(a) must be a power of 2.
func FFT(a []complex128, inverse bool) {
	n := len(a)
	if n <= 1 {
		return
	}

	// Bit-reversal permutation
	for i, j := 1, 0; i < n; i++ {
		bit := n >> 1
		for ; j&bit != 0; bit >>= 1 {
			j ^= bit
		}
		j ^= bit
		if i < j {
			a[i], a[j] = a[j], a[i]
		}
	}

	sign := -2.0 * math.Pi
	if inverse {
		sign = 2.0 * math.Pi
	}

	for length := 2; length <= n; length <<= 1 {
		half := length >> 1
		ang := sign / float64(length)
		wlen := complex(math.Cos(ang), math.Sin(ang))
		for i := 0; i < n; i += length {
			w := complex(1, 0)
			for j := 0; j < half; j++ {
				u := a[i+j]
				v := a[i+j+half] * w
				a[i+j] = u + v
				a[i+j+half] = u - v
				w *= wlen
			}
		}
	}

	if inverse {
		invN := complex(1.0/float64(n), 0)
		for i := 0; i < n; i++ {
			a[i] *= invN
		}
	}
}

// ConjugateCopy returns a slice containing the complex conjugate of src.
func ConjugateCopy(src []complex128) []complex128 {
	out := make([]complex128, len(src))
	for i, v := range src {
		out[i] = cmplx.Conj(v)
	}
	return out
}
