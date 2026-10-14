# The helper report

Fusion Cloud exposes no "run any SQL" API. What every pod *does* have is **BI Publisher**, which can run a data model
and return CSV. Fusion SQL DEV (like the open-source *fusion-query* project it builds on) uses a tiny, generic
BI Publisher **data model + report** pair that opens a cursor over the SQL text you send.

## What gets installed

Into your personal catalog folder (**My Folders**), by default:

```
/~<your user>/FusionSqlDev/v2/dm.xdm    data model  (one data set, one parameter P_B64_CONTENT)
/~<your user>/FusionSqlDev/v2/csv.xdo   report      (empty layout, output = CSV, delimiter |)
```

* **Data model** - a single anonymous PL/SQL data set:

  ```sql
  DECLARE
    TYPE CurType IS REF CURSOR;
    xdo_cursor CurType;
  BEGIN
    OPEN :xdo_cursor FOR utl_raw.cast_to_varchar2(UTL_COMPRESS.lz_uncompress(TO_BLOB(
         utl_encode.base64_decode(UTL_RAW.CAST_TO_RAW(:P_B64_CONTENT)))));
  END;
  ```
  The extension gzips + base64-encodes your statement (so size limits and special characters are never an issue),
  wraps it as `SELECT * FROM (<your sql>) OFFSET n ROWS FETCH NEXT m ROWS ONLY` for paging, and sends it as the parameter.
* **Report** - references that data model, has an empty layout and the report-level config `csv-delimiter = |`, so the
  output *is* the raw data set as CSV.

Data source defaults to `ApplicationDB_FSCM`; choose another (e.g. `ApplicationDB_HCM`) under *Advanced options* of the
connection (a separate folder `v2-hcm` is used).

## Install, repair, remove

* Automatic: first run (setting `fusionSqlDev.runtime.install`: `ask` | `auto` | `never`).
* **Fusion SQL: Install / Repair Helper Report on Pod** (right-click a connection) re-uploads both objects.
* **Install Helper From a Catalog File (.xdrz)** uploads the data model and report found inside any `.xdrz`
  (for example `FusionQueryProxy.xdrz` from fusion-query) - the fallback if a pod rejects the generated definition.
* Remove: delete the folder `FusionSqlDev` from *My Folders* in BI Publisher (Catalog).

Helpers imported by hand for 1.x/fusion-query (`/~user/FusionQuery/v1/csv.xdo` or
`/Custom/FusionQuery/Proxy/v1/csv.xdo`) are discovered automatically and reused.

## "Security violation … expect: 514, actual: 0"

BI Publisher uploaded the data model but refused to create the report. Owning *My Folders* is not enough: creating reports needs a BI authoring role (e.g. *BI Author Role* / *BI Administrator Role*, assigned in the Security Console), even for a Fusion system administrator. Either get the role, or: **Save Helper Catalog File…** → BI Publisher *Catalog → My Folders → Upload* → pick the `.xdrz`, then *Test Connection*. If the objects end up at a different path, put it in the connection's *Existing helper report* field.

## Shared installation (admins)

An administrator can install the helper once in a shared folder (e.g. `/Shared Folders/Custom/FusionSqlDev`) by
connecting once with *Catalog folder* set to `/Shared Folders/Custom` (Advanced options), then give the BI roles that
should run it execute permission. Team members then set the same *Catalog folder*.

## Manual install (no automatic option works)

Use **Install Helper From a Catalog File (.xdrz)** with `FusionQueryProxy.xdrz` (from the fusion-query project), or
import the `.xdrz` through BI Publisher's *Catalog → Upload* into *My Folders* and set the connection's *Catalog folder*
accordingly. Building the two objects by hand is possible (a data model with the PL/SQL above and a mandatory text
parameter `P_B64_CONTENT`, plus a report with an empty layout and CSV output using `|` as delimiter) but the archive
route is far less error-prone.

## Security notes

* BI Publisher executes the SQL as the **data source's database user**, not as you, so it can read whatever that
  account can read - Fusion's role-based data security does *not* apply. This is inherent to the technique.
  Therefore: keep the helper in **your personal folder** (only you can run it), or restrict the shared folder to
  trusted roles.
* The cursor accepts queries only. DML/DDL/PL-SQL cannot be executed through it, and the extension refuses them before
  sending anything.
* Nothing in the helper phones home; your SQL and results travel only between VS Code and your pod over HTTPS.
