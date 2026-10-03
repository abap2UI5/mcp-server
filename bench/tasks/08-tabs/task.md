# Sales order with tabs

Build an abap2UI5 app in the ABAP class `zcl_bench_08`.

A page titled "Sales order 1001" shows the order's customer ("Miller Ltd.")
and total ("1,840.00 EUR") at the top. Below, three tabs:

- "Items": a table of the order items (product, quantity, price) - three
  sample items are enough;
- "Customer": the customer's address (street, city, country) as read-only
  fields;
- "Notes": a multi-line text field for internal notes and a button "Save
  notes", which shows the message toast "Notes saved".

Deliver the class in abapGit format in the folder `src/`:
`src/zcl_bench_08.clas.abap` and its metadata file `src/zcl_bench_08.clas.xml`.
The app must run on abap2UI5 1.145.0 and SAPUI5 1.71 or later.
