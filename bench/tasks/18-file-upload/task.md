# Material list upload

Build an abap2UI5 app in the ABAP class `zcl_bench_18`.

A page titled "Material upload" lets the user pick a CSV file from their
computer and upload it to the backend. The file has one material per line in
the form `material;description;quantity`, without a header line, for example:

    M-100;Office chair;4
    M-200;Desk lamp;12

After the upload, the backend reads the file and shows its lines in a table
with the columns Material, Description and Quantity, and a message toast says
"<n> materials uploaded". Empty lines are skipped. If the file cannot be read,
an error message box shows the reason.

Deliver the class in abapGit format in the folder `src/`:
`src/zcl_bench_18.clas.abap` and its metadata file `src/zcl_bench_18.clas.xml`.
The app must run on abap2UI5 1.145.0 and SAPUI5 1.71 or later.
