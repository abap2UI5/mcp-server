# Product catalog with search and sorting

Build an abap2UI5 app in the ABAP class `zcl_bench_07`.

A page titled "Product catalog" lists products in a table with the columns
Product, Category and Price (in EUR). Fill it with at least eight sample
products from at least three categories.

Above the table there is a search field: searching shows only the products
whose name contains the search text, ignoring upper and lower case; an empty
search shows all products again. Two buttons sort the table by price,
"Price ascending" and "Price descending".

Deliver the class in abapGit format in the folder `src/`:
`src/zcl_bench_07.clas.abap` and its metadata file `src/zcl_bench_07.clas.xml`.
The app must run on abap2UI5 1.145.0 and SAPUI5 1.71 or later.
