# Supplier value help

Build an abap2UI5 app in the ABAP class `zcl_bench_14`.

A page titled "Purchase requisition" with a form containing the field
"Supplier". The field has a value help (the small icon at the end of the
field). Opening the value help shows a dialog with a table of suppliers -
supplier number, name and city; use six sample suppliers - and a search field
above the table that narrows the list down by name.

Choosing a supplier in the dialog closes it, puts the supplier number into the
"Supplier" field and shows the supplier's name in a read-only field next to
it. A "Cancel" button closes the dialog without changing anything.

Deliver the class in abapGit format in the folder `src/`:
`src/zcl_bench_14.clas.abap` and its metadata file `src/zcl_bench_14.clas.xml`.
The app must run on abap2UI5 1.145.0 and SAPUI5 1.71 or later.
