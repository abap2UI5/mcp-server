# Stock check

Build an abap2UI5 app in the ABAP class `zcl_bench_04`.

A page titled "Stock check" for the material "Office chair". 100 pieces are in
stock. The user enters a quantity and presses "Check availability". The answer
comes as a message box whose kind matches the result:

- a quantity of zero or less: an error, "Enter a quantity greater than zero";
- more than 100: a warning, "Only 100 pieces are available";
- otherwise: a success message, "<quantity> pieces reserved".

Deliver the class in abapGit format in the folder `src/`:
`src/zcl_bench_04.clas.abap` and its metadata file `src/zcl_bench_04.clas.xml`.
The app must run on abap2UI5 1.145.0 and SAPUI5 1.71 or later.
