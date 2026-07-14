# Third-party notices

Forgeboard is distributed under the MIT License. Its desktop installers also contain the
following separately licensed software.

## Dugite 3.2.2

Source: <https://github.com/desktop/dugite/tree/v3.2.2>

MIT License

Copyright (c) 2016 GitHub and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Bundled Git toolchain / dugite-native v2.53.0-3

Forgeboard invokes a separately built Git executable distributed by
[`dugite-native`](https://github.com/desktop/dugite-native/tree/v2.53.0-3). Git is licensed under
GNU General Public License version 2. A verbatim copy is installed at `licenses/git/COPYING` and is
also tracked at [`third_party/git/COPYING`](third_party/git/COPYING).

The exact build recipe is dugite-native commit
[`f49d0098409aa243de8b9162127025ab0bb07a88`](https://github.com/desktop/dugite-native/commit/f49d0098409aa243de8b9162127025ab0bb07a88).
Its macOS and Linux builds use Git source commit
[`67ad42147a7acc2af6074753ebd03d904476118f`](https://github.com/git/git/commit/67ad42147a7acc2af6074753ebd03d904476118f).
The Windows MinGit payload corresponds to Git for Windows commit
[`f8165afd89b0c190677a093f20894f5fce12f97a`](https://github.com/git-for-windows/git/commit/f8165afd89b0c190677a093f20894f5fce12f97a)
(`v2.53.0.windows.3`). The distribution also contains Git LFS
[`b84b33847fe6458f36ef521534dc0eac953cb379`](https://github.com/git-lfs/git-lfs/commit/b84b33847fe6458f36ef521534dc0eac953cb379)
(`v3.7.1`) and Git Credential Manager
[`5fa7116896c82164996a609accd1c5ad90fe730a`](https://github.com/git-ecosystem/git-credential-manager/commit/5fa7116896c82164996a609accd1c5ad90fe730a)
(`v2.7.3`).

Every tagged Forgeboard GitHub Release attaches immutable source archives for all five commits
alongside the installers. [`third_party/dugite-sources.json`](third_party/dugite-sources.json) is the
machine-checked source/version ledger; CI fails if the pinned Dugite package or its embedded native
Git metadata drifts from it. The embedded distribution's additional dependency notices remain
available at `git/libexec/git-core/NOTICE` inside the application resources.

Bundled Git remains a separate program; Forgeboard's own source continues to be MIT licensed.
