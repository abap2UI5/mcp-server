# Customer list and customer detail - two apps

Build two abap2UI5 apps that work together: the list app in the ABAP class
`zcl_bench_17` and the detail app in the ABAP class `zcl_bench_17_detail`.

The list app shows a page titled "Customers" with a table of customers
(number, name, city, phone); use four sample customers. Clicking a customer
row opens the detail app for that customer.

The detail app shows a page titled with the customer's name, the customer's
number, name and city as read-only fields and the phone number as an editable
field. Its back button (in the page header) returns to the list without
changes. A "Save" button returns to the list as well, and the list then shows
the changed phone number for that customer.

Deliver both classes in abapGit format in the folder `src/`:
`src/zcl_bench_17.clas.abap`, `src/zcl_bench_17_detail.clas.abap` and their
metadata files `src/zcl_bench_17.clas.xml` and `src/zcl_bench_17_detail.clas.xml`.
The apps must run on abap2UI5 1.145.0 and SAPUI5 1.71 or later.
