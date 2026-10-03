CLASS zcl_bench_07 DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES:
      BEGIN OF ty_s_product,
        name     TYPE string,
        category TYPE string,
        price    TYPE p LENGTH 10 DECIMALS 2,
      END OF ty_s_product.
    TYPES ty_t_product TYPE STANDARD TABLE OF ty_s_product WITH EMPTY KEY.
    DATA search   TYPE string.
    DATA products TYPE ty_t_product.

  PROTECTED SECTION.
    DATA all_products TYPE ty_t_product.
    DATA client       TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.
    METHODS filter.
    METHODS model_init.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_bench_07 IMPLEMENTATION.

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
            )->a( n = `title` v = `Product catalog` ).

    DATA(table) = page->ele( `Table`
        )->a( n = `items` v = client->_bind( products ) ).

    table->ele( `headerToolbar`
        )->ele( `OverflowToolbar`

            )->tag( `SearchField`
                )->a( n = `value`  v = client->_bind( search )
                )->a( n = `width`  v = `20rem`
                )->a( n = `search` v = client->_event( `SEARCH` )
            )->tag( `ToolbarSpacer`
            )->tag( `Button`
                )->a( n = `text`  v = `Price ascending`
                )->a( n = `icon`  v = `sap-icon://sort-ascending`
                )->a( n = `press` v = client->_event( `SORT_ASC` )
            )->tag( `Button`
                )->a( n = `text`  v = `Price descending`
                )->a( n = `icon`  v = `sap-icon://sort-descending`
                )->a( n = `press` v = client->_event( `SORT_DESC` ) ).

    table->ele( `columns`
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Product`
        )->end(
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Category`
        )->end(
        )->ele( `Column`
            )->a( n = `hAlign` v = `End`
            )->tag( `Text`
                )->a( n = `text` v = `Price (EUR)` ).

    table->ele( `items`
        )->ele( `ColumnListItem`
            )->ele( `cells`

                )->tag( `Text`
                    )->a( n = `text` v = `{NAME}`
                )->tag( `Text`
                    )->a( n = `text` v = `{CATEGORY}`
                )->tag( `ObjectNumber`
                    )->a( n = `number` v = `{PRICE}`
                    )->a( n = `unit`   v = `EUR` ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD on_event.

    CASE client->get_event( ).
      WHEN `SEARCH`.
        filter( ).
      WHEN `SORT_ASC`.
        SORT products BY price ASCENDING.
      WHEN `SORT_DESC`.
        SORT products BY price DESCENDING.
    ENDCASE.

  ENDMETHOD.

  METHOD filter.

    DATA(query) = to_upper( condense( search ) ).
    CLEAR products.
    LOOP AT all_products INTO DATA(product).
      IF query IS INITIAL OR find( val = to_upper( product-name ) sub = query ) >= 0.
        APPEND product TO products.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.

  METHOD model_init.

    all_products = VALUE #( ( name = `Notebook Basic 15` category = `Laptops`     price = `956.00` )
                            ( name = `Notebook Pro 17`   category = `Laptops`     price = `1570.00` )
                            ( name = `Ergo Screen E-I`   category = `Monitors`    price = `230.00` )
                            ( name = `Flat Basic`        category = `Monitors`    price = `399.00` )
                            ( name = `Comfort Easy`      category = `Accessories` price = `39.00` )
                            ( name = `Wireless Mouse`    category = `Accessories` price = `19.90` )
                            ( name = `Laser Printer 2`   category = `Printers`    price = `249.00` )
                            ( name = `Photo Printer`     category = `Printers`    price = `179.00` ) ).
    products = all_products.

  ENDMETHOD.

ENDCLASS.
