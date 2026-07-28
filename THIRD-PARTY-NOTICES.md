# Third-Party Notices

MUSIXQUARE includes open-source software and visual assets. This file records
the licensing and copyright information distributed with those components.

---

## 1. PeerJS (Local And Explicit-Development WebRTC Transport)

- **License**: MIT License
- **Copyright**: Copyright (c) 2015 Michelle Bu and Eric Zhang

## 2. node-qrcode (QR Code Generation)

- **License**: MIT License
- **Copyright**: Copyright (c) 2012 Ryan Day

## 3. content-shield (Chat Filtering)

- **License**: MIT License
- **Copyright**: Copyright (c) 2025 ZachHandley

## 4. @wasm-audio-decoders/flac 0.2.10 (Streaming FLAC Decoder)

- **License declaration**: MIT (`package.json`)
- **Author**: Ethan Halsall
- **Source**: https://github.com/eshaz/wasm-audio-decoders/tree/main/src/flac
- **Bundled upstream code**: libFLAC; see section 12.
- **Transitive runtime dependencies**: `@wasm-audio-decoders/common` and
  `codec-parser`; see sections 5 and 6.
- **Packaging note**: the published npm package declares MIT but does not
  include a standalone `LICENSE` file. The MIT text below records the declared
  terms without supplying a missing upstream copyright line.

## 5. @wasm-audio-decoders/common 9.0.7 (WASM Decoder Runtime)

- **License declaration**: MIT (`package.json`)
- **Author**: Ethan Halsall
- **Source**: https://github.com/eshaz/wasm-audio-decoders/tree/main/src/common
- **Bundled upstream code**: a modified, inlined copy of Mark Adler's `puff`;
  see section 13.
- **Transitive runtime dependencies**: `@eshaz/web-worker` and `simple-yenc`;
  see sections 7 and 8.
- **Packaging note**: the published npm package declares MIT but does not
  include a standalone `LICENSE` file. The MIT text below records the declared
  terms without supplying a missing upstream copyright line.

## 6. codec-parser 2.5.0 (FLAC Frame Parser)

- **License**: GNU Lesser General Public License v3.0 or later
  (`LGPL-3.0-or-later`)
- **Copyright**: Copyright 2020-2023 Ethan Halsall
- **Source**: https://github.com/eshaz/codec-parser
- **License text**: https://www.gnu.org/licenses/lgpl-3.0.txt
- **Distribution note**: this is an unmodified, exact-version transitive
  dependency. Its complete LGPL text is included in the published npm package
  as `LICENSE`; the exact version and integrity hash are recorded in
  `package-lock.json`.

## 7. @eshaz/web-worker 1.2.2 (Worker Compatibility Layer)

- **License**: Apache License 2.0
- **Copyright**: Copyright 2020 Google LLC
- **Source**: https://github.com/eshaz/web-worker
- **License text**:
  [public/licenses/material-icons-apache-2.0.txt](public/licenses/material-icons-apache-2.0.txt)

## 8. simple-yenc 1.0.4 (WASM Payload Encoding)

- **License**: MIT License
- **Copyright**: Copyright 2021-2023 Ethan Halsall
- **Source**: https://github.com/eshaz/simple-yenc

## 9. lanczos-resampler 0.4.1 (Streaming Audio Resampler)

- **License declaration**: MIT (`package.json`)
- **Source**: https://github.com/igankevich/lanczos-resampler
- **Packaging note**: the published npm package declares MIT but does not
  include a standalone `LICENSE` file. The MIT text below records the declared
  terms without supplying a missing upstream copyright line.

## 10. mpg123-decoder 1.0.3 (Streaming MPEG Audio Decoder)

- **Package metadata license declaration**: MIT (`package.json`), covering the
  package-authored wrapper but not relicensing the embedded mpg123 code.
- **Author**: Ethan Halsall
- **Published package**: https://www.npmjs.com/package/mpg123-decoder/v/1.0.3
- **Exact package build source**:
  https://github.com/eshaz/wasm-audio-decoders/tree/8f2428c1cd96b54dab74836c8471ff75fe35cbee/src/mpg123-decoder
- **Published integrity**:
  `sha512-+fjxnWigodWJm3+4pndi+KUg9TBojgn31DPk85zEsim7C6s0X5Ztc/hQYdytXkwuGXH+aB0/aEkG40Emukv6oQ==`
- **Bundled upstream code**: mpg123 1.29.0; see section 11.
- **Transitive runtime dependency**: `@wasm-audio-decoders/common`; see
  section 5.
- **Packaging note**: the published npm package declares MIT but does not
  include a standalone `LICENSE` file. The MIT text below records the declared
  terms without supplying a missing upstream copyright line. The embedded
  mpg123 WebAssembly remains subject to LGPL 2.1 independently.

## 11. mpg123 1.29.0 (Embedded In mpg123-decoder 1.0.3)

- **License**: GNU Lesser General Public License version 2.1
  (`LGPL-2.1-only`)
- **Copyright**: Copyright (c) 1995-2020 by Michael Hipp and others
- **Exact upstream source**:
  https://github.com/madebr/mpg123/tree/08247b317163175e62035893af3ff9e71a5dfefd
- **Build provenance**: the exact `mpg123-decoder` package source above pins
  its `modules/mpg123` submodule to
  `08247b317163175e62035893af3ff9e71a5dfefd`; that upstream revision identifies
  itself as mpg123 1.29.0.
- **License text**:
  [public/licenses/mpg123-lgpl-2.1.txt](public/licenses/mpg123-lgpl-2.1.txt)
- **Distribution obligations**: preserve the copyright and license notices and
  the complete LGPL 2.1 text. Under LGPL 2.1 section 6, distribution of the
  linked WebAssembly must also use a compliant mechanism that lets recipients
  modify the Library and relink the combined work. If relying on section 6(a),
  provide the complete machine-readable source for mpg123 (including any
  changes) and the materials needed to relink; if relying on section 6(d) for
  downloads from a designated place, offer equivalent source access from the
  same place. The exact package build source and upstream source locations are
  recorded above for that purpose.

## 12. libFLAC (Embedded In @wasm-audio-decoders/flac)

- **License**: Xiph.Org BSD-style 3-clause license
- **Copyright**: Copyright (C) 2000-2009 Josh Coalson; Copyright (C) 2011-2025
  Xiph.Org Foundation
- **Source**: https://github.com/xiph/flac
- **Required attribution**:

  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions are met:
  - Redistributions of source code must retain the above copyright notice,
    this list of conditions and the following disclaimer.
  - Redistributions in binary form must reproduce the above copyright notice,
    this list of conditions and the following disclaimer in the documentation
    and/or other materials provided with the distribution.
  - Neither the name of the Xiph.Org Foundation nor the names of its
    contributors may be used to endorse or promote products derived from this
    software without specific prior written permission.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS ``AS IS''
  AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
  ARE DISCLAIMED. IN NO EVENT SHALL THE FOUNDATION OR CONTRIBUTORS BE LIABLE
  FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
  DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
  SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
  CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
  OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
  OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## 13. puff 2.3 (Embedded In @wasm-audio-decoders/common)

- **License**: Mark Adler's permissive zlib-style terms
- **Copyright**: Copyright (C) 2002-2013 Mark Adler, all rights reserved
- **Source**: https://github.com/madler/zlib/tree/master/contrib/puff
- **Upstream packaging note**: the copy states that it was altered for inlining
  into `@wasm-audio-decoders/common`.
- **Required notice**:

  This software is provided 'as-is', without any express or implied warranty.
  In no event will the author be held liable for any damages arising from the
  use of this software.

  Permission is granted to anyone to use this software for any purpose,
  including commercial applications, and to alter it and redistribute it
  freely, subject to the following restrictions:
  1. The origin of this software must not be misrepresented; you must not claim
     that you wrote the original software. If you use this software in a
     product, an acknowledgment in the product documentation would be
     appreciated but is not required.
  2. Altered source versions must be plainly marked as such, and must not be
     misrepresented as being the original software.
  3. This notice may not be removed or altered from any source distribution.

## 14. Google Material Icons (Selected Inline SVG Paths)

- **License**: Apache License 2.0
- **Source**: https://github.com/google/material-design-icons
- **License text**:
  [public/licenses/material-icons-apache-2.0.txt](public/licenses/material-icons-apache-2.0.txt)

---

### License Summaries

#### MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

This notice covers application runtime dependencies. Development and build
tooling remains subject to the licenses distributed with those packages.
