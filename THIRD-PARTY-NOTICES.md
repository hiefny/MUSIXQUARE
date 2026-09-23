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

## 4. jsQR (QR Code Scanning)

- **License**: Apache License 2.0
- **Source**: https://github.com/cozmo/jsQR
- **License text**:
  [Apache License 2.0](public/licenses/material-icons-apache-2.0.txt)

## 5. Google Material Icons (Selected Inline SVG Paths)

- **License**: Apache License 2.0
- **Source**: https://github.com/google/material-design-icons
- **License text**:
  [public/licenses/material-icons-apache-2.0.txt](public/licenses/material-icons-apache-2.0.txt)

## 6. Mediabunny (Large-Track Container Parsing And Incremental Audio)

- **Version**: 1.59.0
- **License**: Mozilla Public License 2.0
- **Copyright**: Copyright (c) 2026-present, Vanilagy and contributors
- **Corresponding source**:
  [Mediabunny at the package's source revision](https://github.com/Vanilagy/mediabunny/tree/2e9f24085d2d1c37e41a254dac745657db98ac3e)
- **License text**:
  [Mozilla Public License 2.0](public/licenses/mediabunny-mpl-2.0.txt)

## 7. WASM Audio Decoder JavaScript Wrappers

- **Packages**: `mpg123-decoder` 1.0.3,
  `@wasm-audio-decoders/flac` 0.2.11,
  `@wasm-audio-decoders/aac` 0.0.1, and
  `@wasm-audio-decoders/common` 9.0.7
- **License of the wrapper code**: MIT License (text below)
- **Copyright notices in the distributed decoder bundles**:
  Copyright 2021-2025 Ethan Halsall (`mpg123-decoder`);
  Copyright 2021-2026 Ethan Halsall (`@wasm-audio-decoders/flac`);
  Copyright 2026 Ethan Halsall (`@wasm-audio-decoders/aac`)
- **Corresponding source and build recipes**:
  [MP3 decoder source revision](https://github.com/eshaz/wasm-audio-decoders/tree/8f2428c1cd96b54dab74836c8471ff75fe35cbee),
  [FLAC decoder source revision](https://github.com/eshaz/wasm-audio-decoders/tree/11530fe7d1ed6d78e6b968297e7f858c322704d2),
  [AAC decoder source revision and build recipes](https://github.com/eshaz/wasm-audio-decoders/tree/826e2d079e744697a2cfcde406db7ffd894447af),
  [shared wrapper source revision](https://github.com/eshaz/wasm-audio-decoders/tree/e4f7eef8cda48719a884023582d8efc5b8d76f6c)

The wrapper's MIT license does not replace the separate licenses of the native
decoder code compiled into its WebAssembly or the dependencies below. MUSIXQUARE
uses the pinned upstream packages without modifying their source files.

## 8. libmpg123 (Native MPEG Decoder Compiled To WebAssembly)

- **License**: GNU Lesser General Public License 2.1, with component-specific
  notices preserved in the upstream COPYING file
- **Copyright**: Copyright (c) 1995-2020 by Michael Hipp and others
- **Corresponding source**:
  [mpg123 source revision referenced by the wrapper's build](https://github.com/madebr/mpg123/tree/08247b317163175e62035893af3ff9e71a5dfefd)
- **License and additional upstream notices**:
  [mpg123 COPYING](public/licenses/mpg123-lgpl-2.1.txt)

## 9. libFLAC (Native FLAC Decoder Compiled To WebAssembly)

- **License**: BSD 3-Clause License
- **Copyright**: Copyright (C) 2000-2009 Josh Coalson;
  Copyright (C) 2011-2025 Xiph.Org Foundation
- **Corresponding source**:
  [FLAC source revision referenced by the wrapper's build](https://github.com/xiph/flac/tree/1507800de4b70e21be71f38caa0d9079d0bc6e45)
- **License text**:
  [FLAC COPYING.Xiph](public/licenses/libflac-bsd-3-clause.txt)

## 10. codec-parser (WASM FLAC And AAC Wrapper Dependency)

- **Version**: 2.5.0
- **License**: GNU Lesser General Public License 3.0 or later
- **Copyright**: Copyright 2020-2023 Ethan Halsall
- **Corresponding source**:
  [codec-parser source revision](https://github.com/eshaz/codec-parser/tree/7834ca161922cd58f5e627d75b7dcc45dcce7e58)
- **License texts**:
  [GNU LGPL 3.0](public/licenses/codec-parser-lgpl-3.0.txt),
  [GNU GPL 3.0 incorporated by LGPL 3.0](public/licenses/gnu-gpl-3.0.txt)

## 11. Decoder Worker And Embedded-Binary Helpers

- **`@eshaz/web-worker` 1.2.2**:
  Apache License 2.0; Copyright 2020 Google LLC.
  [Source](https://github.com/eshaz/web-worker),
  [Apache License 2.0 text](public/licenses/material-icons-apache-2.0.txt).
- **`simple-yenc` 1.0.4**:
  MIT License; Copyright 2021-2023 Ethan Halsall.
  [Source](https://github.com/eshaz/simple-yenc),
  [MIT license and copyright notice](public/licenses/simple-yenc-mit.txt).

## 12. puff (Embedded WASM Binary Decompression)

- **License**: zlib-style license included with puff
- **Copyright**: Copyright (C) 2002-2013 Mark Adler, all rights reserved
- **Source used by the shared wrapper**:
  [puff in wasm-audio-decoders](https://github.com/eshaz/wasm-audio-decoders/tree/e4f7eef8cda48719a884023582d8efc5b8d76f6c/src/common/src/puff)
- **License text**:
  [puff copyright and permission notice](public/licenses/puff-zlib.txt)

The upstream wrapper project alters puff for inlining into its library, as
described in its bundled README. MUSIXQUARE uses that packaged version.

## 13. FAAD2 (Native AAC Decoder Compiled To WebAssembly)

- **License**: GNU General Public License 2.0 or later, with the additional
  upstream notices preserved below
- **Copyright**: Copyright (C) 2003-2005 M. Bakker, Nero AG
- **Upstream copyright message**:
  Code from FAAD2 is copyright (c) Nero AG, www.nero.com
- **Corresponding source**:
  [FAAD2 source revision referenced by the AAC wrapper's build](https://github.com/knik0/faad2/tree/673a22a3c7c33e96e2ff7aae7c4d2bc190dfbf92)
- **License and additional upstream notices**:
  [FAAD2 COPYING](public/licenses/faad2-gpl-2.0.txt),
  [FAAD2 README and copyright notices](public/licenses/faad2-notices.txt)

The AAC wrapper's MIT license does not replace FAAD2's GPL license. The pinned
wrapper source above includes its C glue and build scripts; the pinned FAAD2
source is its native decoder submodule. MUSIXQUARE uses the packaged decoder
without modifying either source.

---

### License Summaries

#### MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

This notice covers application runtime dependencies. Development and build
tooling remains subject to the licenses distributed with those packages.
