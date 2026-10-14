# Third-party notices

Fusion SQL DEV contains **no runtime npm dependencies**. Everything it ships is first-party code,
except for the following idea and file layout:

## fusion-query (MIT)

The technique of running arbitrary SQL through a tiny BI Publisher report - a gzip + base64 encoded
statement passed as parameter `P_B64_CONTENT`, opened as a `REF CURSOR` by an anonymous PL/SQL block in the
data model, and returned as pipe-delimited CSV by an empty layout - and the structure of the helper
catalog objects (`dm.xdm` / `csv.xdo`) originate from the **fusion-query** project by AleCyriaco:
<https://github.com/AleCyriaco/fusion-query>.

```
MIT License

Copyright (c) 2024 fusion-query contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE
OR OTHER DEALINGS IN THE SOFTWARE.
```

Oracle, Oracle Fusion Cloud Applications, BI Publisher, SQL Developer and IAM are trademarks of Oracle
Corporation. This project is not affiliated with or endorsed by Oracle.
