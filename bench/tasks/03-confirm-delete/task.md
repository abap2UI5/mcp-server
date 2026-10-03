# Delete with confirmation

Build an abap2UI5 app in the ABAP class `zcl_bench_03`.

A page titled "Order 4711" shows the text "Customer: Miller Ltd., amount
1,250.00 EUR" and a button "Delete order". Pressing the button asks for
confirmation in a message box ("Do you really want to delete order 4711?")
with the two actions OK and Cancel. When the user confirms with OK, a message
toast says "Order 4711 deleted" and the "Delete order" button is disabled.
Cancel leaves everything as it was.

Deliver the class in abapGit format in the folder `src/`:
`src/zcl_bench_03.clas.abap` and its metadata file `src/zcl_bench_03.clas.xml`.
The app must run on abap2UI5 1.145.0 and SAPUI5 1.71 or later.
