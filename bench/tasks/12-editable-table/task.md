# Price list maintenance

Build an abap2UI5 app in the ABAP class `zcl_bench_12`.

A page titled "Price list" with an editable table: every row has the fields
Material, Description, Price and Currency, all of them editable in place.
Start with three sample rows.

A toolbar above the table offers:

- "Add row": appends an empty row;
- "Delete": removes the rows the user has selected in the table;
- "Save": checks that no row has an empty Material. If one has, an error
  message box says "Every row needs a material"; otherwise the message toast
  "<n> rows saved" is shown.

Deliver the class in abapGit format in the folder `src/`:
`src/zcl_bench_12.clas.abap` and its metadata file `src/zcl_bench_12.clas.xml`.
The app must run on abap2UI5 1.145.0 and SAPUI5 1.71 or later.
