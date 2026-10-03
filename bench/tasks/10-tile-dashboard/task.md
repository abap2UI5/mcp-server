# Sales dashboard with tiles

Build an abap2UI5 app in the ABAP class `zcl_bench_10`.

A page titled "Sales dashboard" shows four key figures as tiles, side by side
and wrapping onto the next line on small screens. Each tile has a header, a
large number and a unit:

| Header            | Number | Unit      |
| ----------------- | ------ | --------- |
| Open orders       | 42     | orders    |
| Revenue this month| 1.2    | M EUR     |
| Overdue invoices  | 7      | invoices  |
| New customers     | 15     | customers |

The "Overdue invoices" number is shown in red (critical). Pressing a tile
shows the message toast "<header> - details will follow". No charts.

Deliver the class in abapGit format in the folder `src/`:
`src/zcl_bench_10.clas.abap` and its metadata file `src/zcl_bench_10.clas.xml`.
The app must run on abap2UI5 1.145.0 and SAPUI5 1.71 or later.
