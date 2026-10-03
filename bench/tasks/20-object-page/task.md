# Product object page

Build an abap2UI5 app in the ABAP class `zcl_bench_20`.

Show the product "Ergo Screen E-I" as an object page (the UI5 object page
layout). The header shows the product name, its category "Monitors", the
price "230.00 EUR" and the stock status "Low stock" in a warning color.

The page has three sections, reachable through the section navigation:

- "General information": a read-only form with product number HT-1010,
  weight 4.2 KG and dimensions 30 x 18 x 3 cm;
- "Suppliers": a table of three suppliers (name, country, lead time in days);
- "Reviews": a list of three customer reviews, each with author and text.

Deliver the class in abapGit format in the folder `src/`:
`src/zcl_bench_20.clas.abap` and its metadata file `src/zcl_bench_20.clas.xml`.
The app must run on abap2UI5 1.145.0 and SAPUI5 1.71 or later.
