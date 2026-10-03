# Shipping destination

Build an abap2UI5 app in the ABAP class `zcl_bench_06`.

A page titled "Shipping destination" with two dropdowns. The first offers the
countries Germany, France and Italy. The second offers only the cities of the
country chosen in the first:

- Germany: Berlin, Hamburg, Munich
- France: Paris, Lyon, Marseille
- Italy: Rome, Milan, Naples

Changing the country empties the city choice. A button "Confirm" shows the
message toast "Shipping to <city>, <country>"; when no city is chosen yet it
shows "Choose a city first" instead.

Deliver the class in abapGit format in the folder `src/`:
`src/zcl_bench_06.clas.abap` and its metadata file `src/zcl_bench_06.clas.xml`.
The app must run on abap2UI5 1.145.0 and SAPUI5 1.71 or later.
