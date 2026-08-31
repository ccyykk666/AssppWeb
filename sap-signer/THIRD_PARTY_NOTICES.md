# Third-party notices

The bundled SAP signer directly depends on the official
[`majd/ipatool`](https://github.com/majd/ipatool) module, pinned in `go.mod` to
commit `d5d0b56faf64e3fdef885d49e7928b390aadb6c7`. No source from an AssppWeb fork
is included.

## ipatool

MIT License

Copyright (c) 2021 Majd Alfhaily

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Unicorn Engine

The ipatool SAP runtime downloads a checksum-pinned Unicorn Engine 2.1.4
runtime for the current platform on first use. Unicorn Engine is distributed
under the GPL-2.0 license; see
<https://github.com/unicorn-engine/unicorn/blob/master/COPYING>.
