# Contacts with a create dialog

Build an abap2UI5 app in the ABAP class `zcl_bench_15`.

A page titled "Contacts" lists contacts in a table with the columns First
name, Last name and Email; start with two sample contacts. A button "Add
contact" opens a dialog with a form for first name, last name and email, and
the buttons "Save" and "Cancel".

"Save" adds the contact to the table and closes the dialog - but only when a
last name was entered; otherwise the dialog stays open and the last name field
is marked as an error with the text "Enter a last name". "Cancel" closes the
dialog without adding anything. Every time the dialog opens, its fields are
empty.

Deliver the class in abapGit format in the folder `src/`:
`src/zcl_bench_15.clas.abap` and its metadata file `src/zcl_bench_15.clas.xml`.
The app must run on abap2UI5 1.145.0 and SAPUI5 1.71 or later.
