# Organization tree

Build an abap2UI5 app in the ABAP class `zcl_bench_09`.

A page titled "Organization" shows the company structure as an expandable
tree with three levels:

- Board
  - Sales: Sales Europe, Sales Americas
  - Finance: Accounting, Controlling
  - IT: Development, Operations

Clicking an entry shows the message toast "Selected: <entry name>".

Deliver the class in abapGit format in the folder `src/`:
`src/zcl_bench_09.clas.abap` and its metadata file `src/zcl_bench_09.clas.xml`.
The app must run on abap2UI5 1.145.0 and SAPUI5 1.71 or later.
