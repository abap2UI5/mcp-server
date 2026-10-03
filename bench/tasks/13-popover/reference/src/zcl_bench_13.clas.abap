CLASS zcl_bench_13 DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES:
      BEGIN OF ty_s_order,
        id       TYPE string,
        customer TYPE string,
        amount   TYPE p LENGTH 10 DECIMALS 2,
        status   TYPE string,
      END OF ty_s_order.
    DATA orders TYPE STANDARD TABLE OF ty_s_order WITH EMPTY KEY.
    DATA detail TYPE ty_s_order.

  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.
    METHODS popover_display
      IMPORTING
        anchor TYPE string.
    METHODS model_init.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_bench_13 IMPLEMENTATION.

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
            )->a( n = `title` v = `Open orders` ).

    DATA(table) = page->ele( `Table`
        )->a( n = `items` v = client->_bind( orders ) ).

    table->ele( `columns`
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Order`
        )->end(
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Customer`
        )->end(
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Amount (EUR)`
        )->end(
        )->ele( `Column` ).

    table->ele( `items`
        )->ele( `ColumnListItem`
            )->ele( `cells`

                )->tag( `Text`
                    )->a( n = `text` v = `{ID}`
                )->tag( `Text`
                    )->a( n = `text` v = `{CUSTOMER}`
                )->tag( `Text`
                    )->a( n = `text` v = `{AMOUNT}`
                )->tag( `Button`
                    )->a( n = `text`  v = `Details`
                    )->a( n = `press` v = client->_event( val = `DETAILS` t_arg = VALUE #( ( `${$source>/id}` ) ( `${ID}` ) ) ) ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD on_event.

    CASE client->get_event( ).
      WHEN `DETAILS`.
        detail = VALUE #( orders[ id = client->get_event_arg( 2 ) ] OPTIONAL ).
        popover_display( client->get_event_arg( 1 ) ).
      WHEN `CLOSE`.
        client->popover_destroy( ).
    ENDCASE.

  ENDMETHOD.

  METHOD popover_display.

    DATA(fragment) = z2ui5_cl_ui5_view_builder=>factory(
        )->ele( n = `FragmentDefinition` ns = `core`
            )->a( n = `xmlns`      v = `sap.m`
            )->a( n = `xmlns:core` v = `sap.ui.core` ).

    DATA(popover) = fragment->ele( `Popover`
        )->a( n = `title`     t = |Order { detail-id }|
        )->a( n = `placement` v = `Auto` ).

    popover->ele( `VBox`
        )->a( n = `class` v = `sapUiSmallMargin`

        )->tag( `ObjectStatus`
            )->a( n = `title` v = `Customer`
            )->a( n = `text`  v = client->_bind( detail-customer )
        )->tag( `ObjectStatus`
            )->a( n = `title` v = `Amount (EUR)`
            )->a( n = `text`  v = client->_bind( detail-amount )
        )->tag( `ObjectStatus`
            )->a( n = `title` v = `Status`
            )->a( n = `text`  v = client->_bind( detail-status ) ).

    popover->ele( `footer`
        )->ele( `OverflowToolbar`
            )->tag( `ToolbarSpacer`
            )->tag( `Button`
                )->a( n = `text`  v = `Close`
                )->a( n = `press` v = client->_event( `CLOSE` ) ).

    client->popover_display( xml = fragment->stringify( ) by_id = anchor ).

  ENDMETHOD.

  METHOD model_init.

    orders = VALUE #( ( id = `1001` customer = `Miller Ltd.`      amount = `1840.00` status = `In process` )
                      ( id = `1002` customer = `Baker & Sons`     amount = `320.50`  status = `Shipped` )
                      ( id = `1003` customer = `Global Trade AG`  amount = `9800.00` status = `In process` )
                      ( id = `1004` customer = `Northwind`        amount = `75.00`   status = `Delivered` ) ).

  ENDMETHOD.

ENDCLASS.
