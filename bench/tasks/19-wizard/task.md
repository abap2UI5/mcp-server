# Leave request wizard

Build an abap2UI5 app in the ABAP class `zcl_bench_19`.

A page titled "Leave request" guides the employee through a wizard (the UI5
wizard control) with three steps:

1. "Type": choose the kind of leave - Vacation, Sick leave or Training.
2. "Dates": a start date and an end date.
3. "Summary": shows the chosen type and dates as read-only text, and a
   "Submit" button.

"Submit" checks that both dates are filled and the end date is not before the
start date. If the check fails, an error message box says what is wrong.
Otherwise the message toast "Leave request submitted" is shown.

Deliver the class in abapGit format in the folder `src/`:
`src/zcl_bench_19.clas.abap` and its metadata file `src/zcl_bench_19.clas.xml`.
The app must run on abap2UI5 1.145.0 and SAPUI5 1.71 or later.
