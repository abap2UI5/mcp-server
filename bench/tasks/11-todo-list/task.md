# To-do list

Build an abap2UI5 app in the ABAP class `zcl_bench_11`.

A page titled "To-do" with an input field and a button "Add" that adds the
typed text as a new open to-do to the list below and empties the input. An
empty text is not added; the message toast "Enter a text first" is shown
instead.

Every to-do in the list can be ticked off as done. A filter above the list
switches between "All", "Open" and "Done". A button "Remove done" deletes all
done to-dos. Start with three sample to-dos, one of them done.

Deliver the class in abapGit format in the folder `src/`:
`src/zcl_bench_11.clas.abap` and its metadata file `src/zcl_bench_11.clas.xml`.
The app must run on abap2UI5 1.145.0 and SAPUI5 1.71 or later.
