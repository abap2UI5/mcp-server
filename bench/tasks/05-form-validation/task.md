# Registration form with validation

Build an abap2UI5 app in the ABAP class `zcl_bench_05`.

A page titled "Registration" with a form of three fields: Name, Email and
Age, and a button "Register". When the user presses "Register", the input is
checked:

- Name must not be empty;
- Email must contain an "@" and a "." after it;
- Age must be between 18 and 99.

Every field that fails is marked in red directly at the field, with a short
explanation of what is wrong, and fields that are fine are not marked. Only
when all three fields are valid, a message toast "Registered <name>" is shown.

Deliver the class in abapGit format in the folder `src/`:
`src/zcl_bench_05.clas.abap` and its metadata file `src/zcl_bench_05.clas.xml`.
The app must run on abap2UI5 1.145.0 and SAPUI5 1.71 or later.
