CLASS zcl_bench_10 DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.

  PROTECTED SECTION.
    TYPES:
      BEGIN OF ty_s_kpi,
        header TYPE string,
        value  TYPE string,
        unit   TYPE string,
        color  TYPE string,
      END OF ty_s_kpi.
    DATA kpis   TYPE STANDARD TABLE OF ty_s_kpi WITH EMPTY KEY.
    DATA client TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.
    METHODS model_init.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_bench_10 IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    me->client = client.
    IF client->check_on_init( ).
      model_init( ).
      view_display( ).
    ELSEIF client->check_on_navigated( ).
      view_display( ).
    ELSEIF client->check_on_event( ).
      on_event( ).
    ENDIF.

  ENDMETHOD.

  METHOD view_display.

    DATA(view) = z2ui5_cl_ui5_view_builder=>factory(
        )->ele( n = `View` ns = `mvc`
            )->a( n = `xmlns`        v = `sap.m`
            )->a( n = `xmlns:mvc`    v = `sap.ui.core.mvc`
            )->a( n = `displayBlock` v = `true`
            )->a( n = `height`       v = `100%` ).

    DATA(box) = view->ele( `Shell`
        )->ele( `Page`
            )->a( n = `title` v = `Sales dashboard`
            )->ele( `FlexBox`
                )->a( n = `wrap`  v = `Wrap`
                )->a( n = `class` v = `sapUiSmallMargin` ).

    LOOP AT kpis INTO DATA(kpi).
      box->ele( `GenericTile`
          )->a( n = `header` t = kpi-header
          )->a( n = `class`  v = `sapUiTinyMarginBegin sapUiTinyMarginTop`
          )->a( n = `press`  v = client->_event( val = `TILE_PRESS` t_arg = VALUE #( ( kpi-header ) ) )
          )->ele( `tileContent`
              )->ele( `TileContent`
                  )->a( n = `unit` t = kpi-unit
                  )->ele( `content`
                      )->tag( `NumericContent`
                          )->a( n = `value`      t = kpi-value
                          )->a( n = `valueColor` v = kpi-color
                          )->a( n = `withMargin` v = `false` ).
    ENDLOOP.

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD on_event.

    CASE client->get_event( ).
      WHEN `TILE_PRESS`.
        client->message_toast_display( |{ client->get_event_arg( ) } - details will follow| ).
    ENDCASE.

  ENDMETHOD.

  METHOD model_init.

    kpis = VALUE #( ( header = `Open orders`        value = `42`  unit = `orders`    color = `Neutral` )
                    ( header = `Revenue this month` value = `1.2` unit = `M EUR`     color = `Good` )
                    ( header = `Overdue invoices`   value = `7`   unit = `invoices`  color = `Critical` )
                    ( header = `New customers`      value = `15`  unit = `customers` color = `Good` ) ).

  ENDMETHOD.

ENDCLASS.
