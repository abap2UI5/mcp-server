CLASS zcl_bench_08 DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES:
      BEGIN OF ty_s_item,
        product  TYPE string,
        quantity TYPE i,
        price    TYPE p LENGTH 10 DECIMALS 2,
      END OF ty_s_item.
    DATA items TYPE STANDARD TABLE OF ty_s_item WITH EMPTY KEY.
    DATA notes TYPE string.

  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.
    METHODS model_init.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_bench_08 IMPLEMENTATION.

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
            )->a( n = `xmlns:form`   v = `sap.ui.layout.form`
            )->a( n = `displayBlock` v = `true`
            )->a( n = `height`       v = `100%` ).

    DATA(page) = view->ele( `Shell`
        )->ele( `Page`
            )->a( n = `title` v = `Sales order 1001` ).

    page->tag( `ObjectHeader`
        )->a( n = `title`  v = `Miller Ltd.`
        )->a( n = `number` v = `1,840.00`
        )->a( n = `numberUnit` v = `EUR` ).

    DATA(tabs) = page->ele( `IconTabBar`
        )->a( n = `class` v = `sapUiResponsiveContentPadding`
        )->ele( `items` ).

    DATA(table) = tabs->ele( `IconTabFilter`
        )->a( n = `text` v = `Items`
        )->a( n = `key`  v = `items`
        )->ele( `Table`
            )->a( n = `items` v = client->_bind( items ) ).

    table->ele( `columns`
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Product`
        )->end(
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Quantity`
        )->end(
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Price (EUR)` ).

    table->ele( `items`
        )->ele( `ColumnListItem`
            )->ele( `cells`

                )->tag( `Text`
                    )->a( n = `text` v = `{PRODUCT}`
                )->tag( `Text`
                    )->a( n = `text` v = `{QUANTITY}`
                )->tag( `Text`
                    )->a( n = `text` v = `{PRICE}` ).

    tabs->ele( `IconTabFilter`
        )->a( n = `text` v = `Customer`
        )->a( n = `key`  v = `customer`
        )->ele( n = `SimpleForm` ns = `form`
            )->a( n = `editable` v = `false`

            )->ele( n = `content` ns = `form`

                )->tag( `Label`
                    )->a( n = `text` v = `Street`
                )->tag( `Text`
                    )->a( n = `text` v = `12 Harbour Road`
                )->tag( `Label`
                    )->a( n = `text` v = `City`
                )->tag( `Text`
                    )->a( n = `text` v = `Bristol`
                )->tag( `Label`
                    )->a( n = `text` v = `Country`
                )->tag( `Text`
                    )->a( n = `text` v = `United Kingdom` ).

    tabs->ele( `IconTabFilter`
        )->a( n = `text` v = `Notes`
        )->a( n = `key`  v = `notes`

        )->tag( `TextArea`
            )->a( n = `value` v = client->_bind( notes )
            )->a( n = `rows`  v = `6`
            )->a( n = `width` v = `100%`
        )->tag( `Button`
            )->a( n = `text`  v = `Save notes`
            )->a( n = `type`  v = `Emphasized`
            )->a( n = `press` v = client->_event( `SAVE_NOTES` ) ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD on_event.

    CASE client->get_event( ).
      WHEN `SAVE_NOTES`.
        client->message_toast_display( `Notes saved` ).
    ENDCASE.

  ENDMETHOD.

  METHOD model_init.

    items = VALUE #( ( product = `Office chair` quantity = 4 price = `920.00` )
                     ( product = `Desk lamp`    quantity = 8 price = `320.00` )
                     ( product = `Standing desk` quantity = 1 price = `600.00` ) ).

  ENDMETHOD.

ENDCLASS.
