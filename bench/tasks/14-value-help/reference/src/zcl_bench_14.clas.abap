CLASS zcl_bench_14 DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES:
      BEGIN OF ty_s_supplier,
        id   TYPE string,
        name TYPE string,
        city TYPE string,
      END OF ty_s_supplier.
    TYPES ty_t_supplier TYPE STANDARD TABLE OF ty_s_supplier WITH EMPTY KEY.
    DATA supplier_id   TYPE string.
    DATA supplier_name TYPE string.
    DATA search        TYPE string.
    DATA hits          TYPE ty_t_supplier.

  PROTECTED SECTION.
    DATA suppliers TYPE ty_t_supplier.
    DATA client    TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.
    METHODS popup_display.
    METHODS filter.
    METHODS model_init.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_bench_14 IMPLEMENTATION.

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
            )->a( n = `title` v = `Purchase requisition` ).

    page->ele( n = `SimpleForm` ns = `form`
        )->a( n = `editable` v = `true`

        )->ele( n = `content` ns = `form`

            )->tag( `Label`
                )->a( n = `text` v = `Supplier`
            )->tag( `Input`
                )->a( n = `value`            v = client->_bind( supplier_id )
                )->a( n = `showValueHelp`    v = `true`
                )->a( n = `valueHelpRequest` v = client->_event( `VALUE_HELP` )
            )->tag( `Input`
                )->a( n = `value`    v = client->_bind( supplier_name )
                )->a( n = `editable` v = `false` ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD on_event.

    CASE client->get_event( ).
      WHEN `VALUE_HELP`.
        search = ``.
        filter( ).
        popup_display( ).
      WHEN `SEARCH`.
        filter( ).
      WHEN `CHOOSE`.
        DATA(chosen) = VALUE #( suppliers[ id = client->get_event_arg( ) ] OPTIONAL ).
        IF chosen IS NOT INITIAL.
          supplier_id   = chosen-id.
          supplier_name = chosen-name.
        ENDIF.
        client->popup_destroy( ).
    ENDCASE.

  ENDMETHOD.

  METHOD popup_display.

    DATA(fragment) = z2ui5_cl_ui5_view_builder=>factory(
        )->ele( n = `FragmentDefinition` ns = `core`
            )->a( n = `xmlns`      v = `sap.m`
            )->a( n = `xmlns:core` v = `sap.ui.core` ).

    DATA(dialog) = fragment->ele( `Dialog`
        )->a( n = `title`        v = `Choose a supplier`
        )->a( n = `contentWidth` v = `40rem` ).

    dialog->tag( `SearchField`
        )->a( n = `value`  v = client->_bind( search )
        )->a( n = `search` v = client->_event( `SEARCH` )
        )->a( n = `class`  v = `sapUiSmallMargin`
        )->a( n = `width`  v = `auto` ).

    DATA(table) = dialog->ele( `Table`
        )->a( n = `items` v = client->_bind( hits ) ).

    table->ele( `columns`
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Number`
        )->end(
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Name`
        )->end(
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `City` ).

    table->ele( `items`
        )->ele( `ColumnListItem`
            )->a( n = `type`  v = `Active`
            )->a( n = `press` v = client->_event( val = `CHOOSE` t_arg = VALUE #( ( `${ID}` ) ) )
            )->ele( `cells`

                )->tag( `Text`
                    )->a( n = `text` v = `{ID}`
                )->tag( `Text`
                    )->a( n = `text` v = `{NAME}`
                )->tag( `Text`
                    )->a( n = `text` v = `{CITY}` ).

    dialog->ele( `endButton`
        )->tag( `Button`
            )->a( n = `text`  v = `Cancel`
            )->a( n = `press` v = client->follow_up_action( z2ui5_if_client=>cs_event-popup_close ) ).

    client->popup_display( fragment->stringify( ) ).

  ENDMETHOD.

  METHOD filter.

    DATA(query) = to_upper( condense( search ) ).
    CLEAR hits.
    LOOP AT suppliers INTO DATA(supplier).
      IF query IS INITIAL OR find( val = to_upper( supplier-name ) sub = query ) >= 0.
        APPEND supplier TO hits.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.

  METHOD model_init.

    suppliers = VALUE #( ( id = `S-1000` name = `Acme Office Supplies` city = `Berlin` )
                         ( id = `S-1001` name = `Bright Paper GmbH`    city = `Hamburg` )
                         ( id = `S-1002` name = `Chair Masters`        city = `Munich` )
                         ( id = `S-1003` name = `Desk & Co.`           city = `Vienna` )
                         ( id = `S-1004` name = `Ergo Solutions`       city = `Zurich` )
                         ( id = `S-1005` name = `Furniture Direct`     city = `Paris` ) ).

  ENDMETHOD.

ENDCLASS.
