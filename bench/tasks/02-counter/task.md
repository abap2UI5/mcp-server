# Counter

Build an abap2UI5 app in the ABAP class `zcl_bench_02`.

A page titled "Counter" shows the current count, starting at 0, and three
buttons: "+1" raises the count by one, "-1" lowers it by one, "Reset" sets it
back to 0. The count never goes below zero: pressing "-1" at zero leaves it at
zero and shows the message toast "The counter cannot go below zero".

Deliver the class in abapGit format in the folder `src/`:
`src/zcl_bench_02.clas.abap` and its metadata file `src/zcl_bench_02.clas.xml`.
The app must run on abap2UI5 1.145.0 and SAPUI5 1.71 or later.
