# Order details in a popover

Build an abap2UI5 app in the ABAP class `zcl_bench_13`.

A page titled "Open orders" lists orders in a table with the columns Order,
Customer and Amount (EUR). Use four sample orders, each with a status (for
example "In process", "Shipped").

Every row has a button "Details". Pressing it opens a small popover anchored
next to that button, titled with the order number, showing the order's
customer, amount and status, and a button "Close" that closes the popover.

Deliver the class in abapGit format in the folder `src/`:
`src/zcl_bench_13.clas.abap` and its metadata file `src/zcl_bench_13.clas.xml`.
The app must run on abap2UI5 1.145.0 and SAPUI5 1.71 or later.
