CLASS zcl_bench_12 DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES:
      BEGIN OF ty_s_row,
        selected    TYPE abap_bool,
        material    TYPE string,
        description TYPE string,
        price       TYPE string,
        currency    TYPE string,
      END OF ty_s_row.
    DATA rows TYPE STANDARD TABLE OF ty_s_row WITH EMPTY KEY.

  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.
    METHODS model_init.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_bench_12 IMPLEMENTATION.

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

    DATA(page) = view->ele( `Shell`
        )->ele( `Page`
            )->a( n = `title` v = `Price list` ).

    DATA(table) = page->ele( `Table`
        )->a( n = `items` v = client->_bind( rows )
        )->a( n = `mode`  v = `MultiSelect` ).

    table->ele( `headerToolbar`
        )->ele( `OverflowToolbar`
            )->tag( `ToolbarSpacer`
            )->tag( `Button`
                )->a( n = `text`  v = `Add row`
                )->a( n = `icon`  v = `sap-icon://add`
                )->a( n = `press` v = client->_event( `ADD` )
            )->tag( `Button`
                )->a( n = `text`  v = `Delete`
                )->a( n = `icon`  v = `sap-icon://delete`
                )->a( n = `press` v = client->_event( `DELETE` )
            )->tag( `Button`
                )->a( n = `text`  v = `Save`
                )->a( n = `type`  v = `Emphasized`
                )->a( n = `press` v = client->_event( `SAVE` ) ).

    table->ele( `columns`
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Material`
        )->end(
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Description`
        )->end(
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Price`
        )->end(
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Currency` ).

    table->ele( `items`
        )->ele( `ColumnListItem`
            )->a( n = `selected` v = `{SELECTED}`
            )->ele( `cells`

                )->tag( `Input`
                    )->a( n = `value` v = `{MATERIAL}`
                )->tag( `Input`
                    )->a( n = `value` v = `{DESCRIPTION}`
                )->tag( `Input`
                    )->a( n = `value` v = `{PRICE}`
                )->tag( `Input`
                    )->a( n = `value` v = `{CURRENCY}` ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD on_event.

    CASE client->get_event( ).
      WHEN `ADD`.
        APPEND VALUE #( currency = `EUR` ) TO rows.
      WHEN `DELETE`.
        DELETE rows WHERE selected = abap_true.
      WHEN `SAVE`.
        IF line_exists( rows[ material = `` ] ).
          client->message_box_display( text = `Every row needs a material` type = `error` ).
        ELSE.
          client->message_toast_display( |{ lines( rows ) } rows saved| ).
        ENDIF.
    ENDCASE.

  ENDMETHOD.

  METHOD model_init.

    rows = VALUE #( ( material = `M-100` description = `Office chair` price = `230.00` currency = `EUR` )
                    ( material = `M-200` description = `Desk lamp`    price = `40.00`  currency = `EUR` )
                    ( material = `M-300` description = `Whiteboard`   price = `120.00` currency = `EUR` ) ).

  ENDMETHOD.

ENDCLASS.
