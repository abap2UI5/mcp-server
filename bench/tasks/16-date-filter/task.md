# Bookings by travel date

Build an abap2UI5 app in the ABAP class `zcl_bench_16`.

A page titled "Bookings" lists flight bookings in a table with the columns
Booking, Passenger, Destination and Travel date. Use ten sample bookings
spread over three months.

Above the table the user picks a date range - a "From" and a "To" date - and
presses "Apply": the table then shows only bookings whose travel date lies
within the range, both ends included. "Reset" clears the range and shows all
bookings again. When "To" is before "From", an error message box says "The
end date must not be before the start date" and the table stays unchanged.

Deliver the class in abapGit format in the folder `src/`:
`src/zcl_bench_16.clas.abap` and its metadata file `src/zcl_bench_16.clas.xml`.
The app must run on abap2UI5 1.145.0 and SAPUI5 1.71 or later.
